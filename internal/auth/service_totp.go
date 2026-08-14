package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Второй фактор: включение, выключение и второй шаг входа (фаза 23, слайс F).
// Сама арифметика TOTP — в totp.go, здесь только сценарии.

// ErrTwoFactorRequired — пароль (или провайдер) подтверждён, но у аккаунта
// включён второй фактор: сессия НЕ выдаётся, транспорт ставит короткоживущую
// подписанную cookie и просит код.
//
// Не доменная ошибка: наружу она едет не статусом, а телом «нужен код» либо
// редиректом на экран ввода — маппинга в respond.go у неё нет.
var ErrTwoFactorRequired = errors.New("auth: требуется код второго фактора")

// errTOTPNotConfigured — ключ шифрования секретов не задан (WithTOTPKey не
// вызван). Это ошибка сборки процесса, а не пользователя.
var errTOTPNotConfigured = errors.New("auth: ключ шифрования второго фактора не задан")

// TwoFactorEnabled — включён ли у аккаунта второй фактор (для /auth/me и экрана
// настроек). Незавершённая настройка (confirmed_at IS NULL) считается
// выключенной: секрет показан, но человек его не подтвердил.
func (s *Service) TwoFactorEnabled(ctx context.Context, userID uuid.UUID) (bool, error) {
	st, err := s.repo.GetTOTP(ctx, s.db, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return st.ConfirmedAt != nil, nil
}

// SetupTOTP заводит новый секрет и отдаёт его человеку — в виде строки для
// ручного ввода и ссылки otpauth://, которую телефон открывает приложением.
// Фактор при этом ещё НЕ включён: включает его EnableTOTP после первого
// сошедшегося кода.
//
// Повторный вызов при уже включённом факторе запрещён: он бы выдал новый
// секрет, а старый остался бы в приложении — человек оказался бы с двумя
// разными кодами и без понимания, какой из них настоящий. Сначала выключить.
func (s *Service) SetupTOTP(ctx context.Context, user User) (secret, otpauth string, err error) {
	if len(s.totpSecretKey) == 0 {
		return "", "", errTOTPNotConfigured
	}
	enabled, err := s.TwoFactorEnabled(ctx, user.ID)
	if err != nil {
		return "", "", err
	}
	if enabled {
		return "", "", fmt.Errorf("%w: второй фактор уже включён", domain.ErrConflict)
	}

	raw, err := newTOTPSecret()
	if err != nil {
		return "", "", err
	}
	sealed, err := sealSecret(s.totpSecretKey, raw)
	if err != nil {
		return "", "", err
	}
	if err := s.repo.UpsertTOTPSecret(ctx, s.db, user.ID, sealed); err != nil {
		return "", "", err
	}
	return encodeSecret(raw), otpauthURL(user.Email, raw), nil
}

// EnableTOTP включает фактор по первому сошедшемуся коду и отдаёт резервные
// коды. Показать их можно только сейчас: в БД лежат хеши, и восстановить
// исходные строки нельзя ни нам, ни тому, кто получит дамп.
func (s *Service) EnableTOTP(ctx context.Context, user User, code string) ([]string, error) {
	if len(s.totpSecretKey) == 0 {
		return nil, errTOTPNotConfigured
	}
	st, err := s.repo.GetTOTP(ctx, s.db, user.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: настройка второго фактора не начата", domain.ErrValidation)
		}
		return nil, err
	}
	if st.ConfirmedAt != nil {
		return nil, fmt.Errorf("%w: второй фактор уже включён", domain.ErrConflict)
	}

	secret, err := openSecret(s.totpSecretKey, st.Secret)
	if err != nil {
		return nil, err
	}
	step, ok := verifyTOTP(secret, code, time.Now())
	if !ok {
		return nil, domain.ErrInvalidCredentials
	}

	plain, hashes, err := newRecoveryCodes()
	if err != nil {
		return nil, err
	}
	// Включение и резервные коды — одной транзакцией: фактор без кодов
	// восстановления это ловушка, в которую человек попадает в тот день, когда
	// теряет телефон.
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if e := s.repo.ConfirmTOTP(ctx, tx, user.ID, step); e != nil {
			return e
		}
		// Старые коды предыдущей (выключенной) настройки не должны пережить
		// новую: они выданы к другому секрету.
		if e := s.repo.DeleteRecoveryCodes(ctx, tx, user.ID); e != nil {
			return e
		}
		for _, h := range hashes {
			if e := s.repo.CreateRecoveryCode(ctx, tx, h, user.ID); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return plain, nil
}

// DisableTOTP выключает фактор. Требует и пароль (если он есть), и код —
// украденной сессии с известным паролем не должно хватать, чтобы снять защиту,
// ради которой её включали. Код принимается и резервный: телефон теряют.
func (s *Service) DisableTOTP(ctx context.Context, user User, currentPassword, code string) error {
	if user.PasswordHash != nil {
		ok, err := VerifyPassword(*user.PasswordHash, currentPassword)
		if err != nil {
			return err
		}
		if !ok {
			return domain.ErrInvalidCredentials
		}
	}
	if err := s.consumeSecondFactor(ctx, user.ID, code); err != nil {
		return err
	}
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if e := s.repo.DeleteRecoveryCodes(ctx, tx, user.ID); e != nil {
			return e
		}
		return s.repo.DeleteTOTP(ctx, tx, user.ID)
	})
}

// CompleteTwoFactorLogin — второй шаг входа: код принят, сессия открыта.
// Пользователя называет подписанная cookie, которую транспорт проверил до
// вызова; здесь остаётся проверить сам код.
func (s *Service) CompleteTwoFactorLogin(ctx context.Context, userID uuid.UUID, code string) (User, string, error) {
	if err := s.consumeSecondFactor(ctx, userID, code); err != nil {
		return User{}, "", err
	}
	user, err := s.repo.GetUserByID(ctx, s.db, userID)
	if err != nil {
		return User{}, "", err
	}
	token, err := s.createSession(ctx, userID)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
}

// consumeSecondFactor проверяет код — сперва TOTP, потом резервный — и
// расходует его. Все отказы одинаковы (ErrInvalidCredentials): различать «код
// не тот» и «код уже использован» значит рассказывать перебирающему, где он
// оказался ближе.
func (s *Service) consumeSecondFactor(ctx context.Context, userID uuid.UUID, code string) error {
	if len(s.totpSecretKey) == 0 {
		return errTOTPNotConfigured
	}
	st, err := s.repo.GetTOTP(ctx, s.db, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrInvalidCredentials
		}
		return err
	}
	if st.ConfirmedAt == nil {
		return domain.ErrInvalidCredentials
	}

	secret, err := openSecret(s.totpSecretKey, st.Secret)
	if err != nil {
		return err
	}
	if step, ok := verifyTOTP(secret, code, time.Now()); ok {
		// Однажды предъявленный код второй раз не проходит: перехваченный
		// (через плечо, из лога прокси, с чужого экрана) иначе работал бы все
		// свои полминуты. Отметка монотонна и атомарна — подробности условия
		// в комментарии к MarkTOTPStep в queries.sql.
		fresh, err := s.repo.MarkTOTPStep(ctx, s.db, userID, step)
		if err != nil {
			return err
		}
		if !fresh {
			return domain.ErrInvalidCredentials
		}
		return nil
	}

	used, err := s.repo.ConsumeRecoveryCode(ctx, s.db, hashRecoveryCode(code), userID)
	if err != nil {
		return err
	}
	if !used {
		return domain.ErrInvalidCredentials
	}
	return nil
}

// sessionOrChallenge — общий хвост всех путей входа: у аккаунта с включённым
// вторым фактором сессия не выдаётся, а возвращается ErrTwoFactorRequired.
//
// Один хелпер, а не проверка в каждом пути: забытая проверка в любом из путей
// входа означает дверь мимо второго фактора — то есть его отсутствие. Зовут
// его три пути — пароль, провайдер и разбор гонки; четвёртый, привязка паролем,
// разбирает фактор у себя, потому что обязан сделать это ДО создания привязки
// (см. LinkIdentityWithPassword).
func (s *Service) sessionOrChallenge(ctx context.Context, user User) (User, string, error) {
	enabled, err := s.TwoFactorEnabled(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	if enabled {
		return user, "", ErrTwoFactorRequired
	}
	token, err := s.createSession(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
}
