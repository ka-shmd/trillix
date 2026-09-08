package auth

import (
	"context"
	"errors"
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

// SetAvatar кладёт картинку в хранилище и записывает её ключ в профиль.
// Валидация (PNG/JPEG, размеры) живёт в media и приезжает сюда доменной
// ошибкой — здесь она не дублируется.
//
// Прежний объект не удаляется: ключи контент-адресны, и одну картинку могут
// делить несколько аккаунтов (TD-16 — сборки осиротевших объектов нет вовсе).
func (s *Service) SetAvatar(ctx context.Context, userID uuid.UUID, data []byte) (User, error) {
	if s.avatars == nil {
		return User{}, fmt.Errorf("avatar storage not configured")
	}
	key, err := s.avatars.PutAvatar(ctx, data)
	if err != nil {
		return User{}, err
	}
	return s.repo.SetAvatarKey(ctx, s.db, userID, &key)
}

// ClearAvatar снимает аватар. Хранилище не спрашивается: снять картинку человек
// должен мочь и при недоступном S3 — иначе поломка хранилища запирает профиль.
func (s *Service) ClearAvatar(ctx context.Context, userID uuid.UUID) (User, error) {
	return s.repo.SetAvatarKey(ctx, s.db, userID, nil)
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

// teamOwnership — узкая зависимость от модуля пространств: мешают ли удалению
// аккаунта команды, которыми человек владеет. Объявлена на стороне потребителя
// и подключается в main (WithTeams).
//
// Импортом обойтись нельзя: workspaces уже импортирует auth (его handler стоит
// на RequireAuth), и обратный импорт замкнул бы цикл. Спрашивать самому — тоже:
// владение выражается ролью, а сравнение с ролью вне пакета workspaces
// запрещено (internal/CLAUDE.md).
type teamOwnership interface {
	TeamsBlockingAccountDeletion(ctx context.Context, userID uuid.UUID) ([]string, error)
}

// errTeamsNotConfigured — WithTeams не вызван. Ошибка сборки процесса, не
// пользователя: без ответа на «остаются ли участники» удалять аккаунт нельзя,
// и «наверное, не остаются» здесь не годится.
var errTeamsNotConfigured = errors.New("auth: источник владения пространствами не подключён")

// DeleteAccount помечает аккаунт удалённым и рвёт все его сессии. Данные
// остаются на месте (реальная чистка по 152-ФЗ — отдельная фаза POST-MVP), но
// становятся недостижимыми: все четыре пути «узнать пользователя» слепы к
// пометке, а публичная форма его пространства отвечает 404.
//
// Подтверждение: пароль, если он есть, И код второго фактора, если тот включён.
// Спека (§10) требует «пароль ИЛИ код у аккаунта без пароля» — здесь строже, по
// образцу выключения второго фактора: удаление необратимо, и украденной сессии
// с известным паролем не должно хватать, чтобы снести аккаунт мимо фактора,
// ради которого его включали. У аккаунта без пароля и без фактора
// доказательством остаётся сама сессия — требовать несуществующее нечем.
func (s *Service) DeleteAccount(ctx context.Context, user User, currentPassword, code string) error {
	if s.teams == nil {
		return errTeamsNotConfigured
	}

	if user.PasswordHash != nil {
		ok, err := VerifyPassword(*user.PasswordHash, currentPassword)
		if err != nil {
			return err
		}
		if !ok {
			return domain.ErrInvalidCredentials
		}
	}
	if user.TwoFactorEnabled {
		if err := s.consumeLoginCode(ctx, user.ID, code); err != nil {
			return err
		}
	}

	// Владелец у пространства ровно один, и он же плательщик: уйдя, он оставил
	// бы участников в пространстве, работающем по плану несуществующего
	// аккаунта (TD-53). Личных пространств проверка не касается — они уходят с
	// хозяином, и участников, кроме него, там нет.
	teams, err := s.teams.TeamsBlockingAccountDeletion(ctx, user.ID)
	if err != nil {
		return err
	}
	if len(teams) > 0 {
		return fmt.Errorf("%w: вы владелец пространств (%s) с участниками — передайте владение или удалите их",
			domain.ErrConflict, strings.Join(teams, ", "))
	}

	// Пометка и разрыв сессий — одной транзакцией: помеченный аккаунт с живой
	// cookie означал бы кабинет, который открывается ровно до первого запроса,
	// а несостоявшаяся пометка при удалённых сессиях — «я нажал удалить, а меня
	// просто разлогинило».
	//
	// Повторный вызов (две вкладки) ноль строк на пометке не считает ошибкой:
	// запрос идемпотентен, а сессии рвутся в обоих случаях.
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if _, e := s.repo.MarkUserDeleted(ctx, tx, user.ID); e != nil {
			return e
		}
		return s.repo.DeleteSessionsByUser(ctx, tx, user.ID)
	})
}
