package auth

import (
	"context"
	"errors"
	"fmt"
	netmail "net/mail"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/mail"
)

// Настройки аккаунта (фаза 23 DEV-PLAN). Живут в модуле auth, а не в отдельном
// модуле: users пишет один модуль, два репо над одной таблицей нарушают
// направление зависимостей (internal/CLAUDE.md). Замысел и отвергнутые
// альтернативы — docs/design/account-settings.md.

// MaxPersonNameLen — потолок имени и фамилии в РУНАХ (Zod на фронте считает
// кодовые единицы UTF-16 — расхождение общее для всех лимитов проекта, TD-48).
const MaxPersonNameLen = 100

// UpdateProfile ставит имя и фамилию текущего пользователя. Пустая строка —
// законное значение и означает «стереть»: в БД уезжает NULL.
func (s *Service) UpdateProfile(ctx context.Context, userID uuid.UUID, firstName, lastName string) (User, error) {
	first, err := normalizePersonName(firstName, "имя")
	if err != nil {
		return User{}, err
	}
	last, err := normalizePersonName(lastName, "фамилия")
	if err != nil {
		return User{}, err
	}
	return s.repo.UpdateProfile(ctx, s.db, userID, first, last)
}

// ChangePassword меняет пароль текущего пользователя и **рвёт все его сессии**,
// включая ту, из которой пришёл запрос; взамен открывается новая — её сырой
// токен и возвращается, чтобы транспорт переставил cookie. Человек, сидящий в
// кабинете, остаётся в нём, все остальные устройства разлогиниваются.
//
// Почему не «удалить все, кроме текущей»: смена пароля — событие безопасности, и
// токен сессии по нему ротируется, а не доживает свой месяц. Цена — один
// лишний INSERT; выгода — украденный ранее токен не переживает смену пароля даже
// в том маловероятном случае, если он совпал с текущим.
//
// currentPassword у аккаунта БЕЗ пароля (заведён через провайдера) не
// спрашивается: его не существует, и требовать его значит запереть человека в
// собственном аккаунте. Доказательством в этом случае служит живая сессия.
func (s *Service) ChangePassword(ctx context.Context, user User, currentPassword, newPassword string) (string, error) {
	if err := validatePassword(newPassword); err != nil {
		return "", err
	}

	if user.PasswordHash != nil {
		ok, err := VerifyPassword(*user.PasswordHash, currentPassword)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", domain.ErrInvalidCredentials
		}
	}

	hash, err := HashPassword(newPassword)
	if err != nil {
		return "", err
	}

	// Хеш, разрыв сессий и письмо — одной транзакцией: пароль, сменившийся без
	// разрыва чужих сессий, оставляет вошедшему по старому паролю доступ, ради
	// закрытия которого пароль и меняли.
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if e := s.repo.SetUserPassword(ctx, tx, user.ID, hash); e != nil {
			return e
		}
		if e := s.repo.DeleteSessionsByUser(ctx, tx, user.ID); e != nil {
			return e
		}
		// Единственный способ узнать об угоне — письмо: сам угонщик о смене
		// пароля хозяину не сообщит.
		return s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
			To:       user.Email,
			Template: mail.TemplatePasswordChanged,
			Data:     map[string]any{"link": s.appBaseURL + "/forgot-password"},
		})
	})
	if err != nil {
		return "", err
	}

	return s.createSession(ctx, user.ID)
}

// normalizePersonName приводит присланную строку к тому, что ложится в колонку:
// обрезает пробелы, проверяет длину, пустое отдаёт как nil. Пустая строка и NULL
// не должны быть двумя разными «не указано» — иначе первый же запрос, который
// сравнивает с одним из них, начнёт врать (та же причина в комментарии 0021).
func normalizePersonName(v, field string) (*string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(v) > MaxPersonNameLen {
		return nil, fmt.Errorf("%w: %s длиннее %d символов", domain.ErrValidation, field, MaxPersonNameLen)
	}
	return &v, nil
}

// emailChangeTTL — окно жизни ссылки подтверждения нового адреса. Как у
// подтверждения почты (0012): письмо могут открыть не сразу.
const emailChangeTTL = 24 * time.Hour

// RequestEmailChange начинает смену адреса: проверяет пароль, кладёт одноразовый
// токен и ставит в очередь ДВА письма — ссылку на новый адрес и уведомление на
// старый. `users.email` при этом не меняется: пока по ссылке не перешли, вход
// остаётся по прежнему адресу.
//
// Двухшаговость — не осторожность, а единственный способ не потерять аккаунт на
// опечатке: email и есть ключ восстановления, сброс пароля ходит туда же.
func (s *Service) RequestEmailChange(ctx context.Context, user User, newEmail, currentPassword string) error {
	newEmail = normalizeEmail(newEmail)
	if _, err := netmail.ParseAddress(newEmail); err != nil {
		return fmt.Errorf("%w: некорректный email", domain.ErrValidation)
	}
	if newEmail == user.Email {
		return fmt.Errorf("%w: это уже адрес вашего аккаунта", domain.ErrValidation)
	}

	// Пароль — единственное, что отличает «человек меняет свой адрес» от «угнали
	// сессию и уводят аккаунт»: после смены адреса восстановление пароля пойдёт
	// на новый ящик. У аккаунта без пароля проверять нечем (§4 спеки), и там
	// защитой остаётся уведомление на старый адрес — до слайса F, где появится
	// второй фактор.
	if user.PasswordHash != nil {
		ok, err := VerifyPassword(*user.PasswordHash, currentPassword)
		if err != nil {
			return err
		}
		if !ok {
			return domain.ErrInvalidCredentials
		}
	}

	// Первая из двух проверок занятости. Вторая — при подтверждении: между ними
	// сутки, за которые адрес могут занять регистрацией.
	if err := s.emailFree(ctx, newEmail); err != nil {
		return err
	}

	rawToken, err := newToken()
	if err != nil {
		return err
	}
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if e := s.repo.CreateEmailChangeToken(ctx, tx, hashToken(rawToken), user.ID, newEmail, time.Now().Add(emailChangeTTL)); e != nil {
			return e
		}
		if e := s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
			To:       newEmail,
			Template: mail.TemplateEmailChangeConfirm,
			Data:     map[string]any{"link": s.appBaseURL + "/confirm-email-change?token=" + url.QueryEscape(rawToken)},
		}); e != nil {
			return e
		}
		// Уведомление на СТАРЫЙ адрес — единственный сигнал хозяину, если сессию
		// увели. Ссылки-токена оно не несёт: письмо сообщает, а не даёт прав.
		return s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
			To:       user.Email,
			Template: mail.TemplateEmailChangeNotice,
			Data:     map[string]any{"new_email": newEmail},
		})
	})
}

// ConfirmEmailChange переносит адрес по одноразовому токену из письма. Сессию не
// трогает: пароль не менялся, а по ссылке ходят из почтового клиента, где
// сессии кабинета может не быть вовсе.
func (s *Service) ConfirmEmailChange(ctx context.Context, rawToken string) error {
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		userID, newEmail, e := s.repo.ConsumeEmailChangeToken(ctx, tx, hashToken(rawToken))
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return fmt.Errorf("%w: ссылка недействительна или устарела", domain.ErrValidation)
			}
			return e
		}
		// Вторая проверка занятости — за сутки адрес могли занять регистрацией.
		// Явным запросом, а не ловлей UNIQUE-нарушения: 409 с внятным текстом
		// человеку полезнее, чем 500 из глубины драйвера.
		if e := s.emailFree(ctx, newEmail); e != nil {
			return e
		}
		_, e = s.repo.UpdateUserEmail(ctx, tx, userID, newEmail)
		return e
	})
}

// emailFree — свободен ли адрес. ErrEmailTaken, если занят.
func (s *Service) emailFree(ctx context.Context, email string) error {
	switch _, err := s.repo.GetUserByEmail(ctx, s.db, email); {
	case err == nil:
		return domain.ErrEmailTaken
	case !errors.Is(err, pgx.ErrNoRows):
		return err
	}
	return nil
}

// PurgeExpiredEmailChangeTokens — фоновая чистка истёкших токенов смены адреса.
func (s *Service) PurgeExpiredEmailChangeTokens(ctx context.Context) (int64, error) {
	return s.repo.DeleteExpiredEmailChangeTokens(ctx, s.db)
}
