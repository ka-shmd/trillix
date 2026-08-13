package auth

import (
	"context"
	"fmt"
	"strings"
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
