package auth

import (
	"context"
	"crypto/hmac"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/mail"
)

// Второй фактор — код на почту при входе с незнакомого устройства (0056).
// Примитивы (сам код, токен устройства, метка) — logincode.go; замысел и
// отвергнутые альтернативы — docs/design/two-factor-email.md.

const (
	// loginCodeTTL — сколько живёт код из письма.
	loginCodeTTL = 10 * time.Minute
	// loginCodeMaxAttempts — попыток на один код; дальше он сгорает и нужен
	// новый. Не замена лимитерам: те режут темп, а этот закрывает перебор
	// внутри одного окна.
	loginCodeMaxAttempts = 5
	// knownDeviceTTL — сколько браузер считается знакомым. Дольше сессии
	// (30 суток) сознательно: устройство, протухающее раньше сессии, спрашивало
	// бы код на каждом втором входе со своего же ПК.
	knownDeviceTTL = 180 * 24 * time.Hour
)

// ErrTwoFactorRequired — пароль (или провайдер) подтверждён, но у аккаунта
// включён второй фактор и устройство незнакомо: сессия НЕ выдаётся, код уже
// отправлен на почту, транспорт ставит короткоживущую подписанную cookie и
// просит код.
//
// Не доменная ошибка: наружу она едет не статусом, а телом «нужен код» либо
// редиректом на экран ввода — маппинга в respond.go у неё нет.
var ErrTwoFactorRequired = errors.New("auth: требуется код второго фактора")

// errLoginCodeNotConfigured — ключ подписи кодов не задан (WithLoginCodeKey не
// вызван). Это ошибка сборки процесса, а не пользователя.
var errLoginCodeNotConfigured = errors.New("auth: ключ кода входа не задан")

// Device — то, что путь входа знает о браузере: токен известного устройства из
// cookie (пустой — cookie нет или её стёрли) и User-Agent для метки в списке.
//
// Едет параметром через все пути входа, а не читается сервисом из контекста:
// service не знает про HTTP, а забытая передача обязана ломать компиляцию, а не
// молча превращать знакомый браузер в незнакомый.
type Device struct {
	Token     string
	UserAgent string
}

// TwoFactorEnabled — включён ли у аккаунта второй фактор. Флаг едет в User из
// того же запроса, что и сам пользователь; отдельный поход в базу тут не нужен.
func (s *Service) TwoFactorEnabled(ctx context.Context, userID uuid.UUID) (bool, error) {
	user, err := s.repo.GetUserByID(ctx, s.db, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return user.TwoFactorEnabled, nil
}

// EnableTwoFactor включает фактор. Требует пароль — если он у аккаунта есть.
//
// Мина: без пароля здесь посторонний, добравшийся до чужой незалоченной машины,
// включал бы фактор на свой ящик. У TOTP-версии эта дыра запирала владельца
// навсегда; здесь код всё равно ушёл бы на почту владельца, но пароль стоит
// ровно там же, где он стоит у смены почты и у удаления аккаунта.
func (s *Service) EnableTwoFactor(ctx context.Context, user User, currentPassword string) error {
	if len(s.loginCodeKey) == 0 {
		return errLoginCodeNotConfigured
	}
	if err := s.verifyOwnership(user, currentPassword); err != nil {
		return err
	}
	if user.TwoFactorEnabled {
		return fmt.Errorf("%w: второй фактор уже включён", domain.ErrConflict)
	}
	return s.setTwoFactor(ctx, user, true)
}

// DisableTwoFactor выключает фактор и забывает все известные устройства: с
// выключенным фактором они ничего не значат, а останься они лежать — включение
// обратно молча пропустило бы браузеры, знакомые с прошлого раза.
func (s *Service) DisableTwoFactor(ctx context.Context, user User, currentPassword string) error {
	if err := s.verifyOwnership(user, currentPassword); err != nil {
		return err
	}
	if !user.TwoFactorEnabled {
		return fmt.Errorf("%w: второй фактор не включён", domain.ErrConflict)
	}
	return s.setTwoFactor(ctx, user, false)
}

// setTwoFactor — общий хвост включения и выключения: флаг, уборка устройств и
// кода, письмо-уведомление — одной транзакцией. Письмо здесь же (transactional
// outbox), потому что «настройку сменили, а хозяин не узнал» — это ровно тот
// случай, ради которого уведомления и заводят.
func (s *Service) setTwoFactor(ctx context.Context, user User, enabled bool) error {
	state := "выключена"
	if enabled {
		state = "включена"
	}
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.SetTwoFactorEnabled(ctx, tx, user.ID, enabled); err != nil {
			return err
		}
		if err := s.repo.DeleteKnownDevicesByUser(ctx, tx, user.ID); err != nil {
			return err
		}
		if err := s.repo.DeleteLoginCode(ctx, tx, user.ID); err != nil {
			return err
		}
		return s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
			To:       user.Email,
			Template: mail.TemplateTwoFactorChanged,
			Data:     map[string]any{"state": state},
		})
	})
}

// verifyOwnership — доказательство «это правда хозяин аккаунта» для настроек
// второго фактора. У аккаунта с паролем это пароль; у аккаунта без пароля
// (заведён через провайдера) доказательством служит сама сессия — как и везде
// в настройках.
func (s *Service) verifyOwnership(user User, currentPassword string) error {
	if user.PasswordHash == nil {
		return nil
	}
	ok, err := VerifyPassword(*user.PasswordHash, currentPassword)
	if err != nil {
		return err
	}
	if !ok {
		return domain.ErrInvalidCredentials
	}
	return nil
}

// SendActionCode шлёт код для подтверждения действия в настройках — смены
// адреса и удаления аккаунта.
//
// Механика и хранилище общие с кодом входа (строка одна на аккаунт), различается
// только письмо: «код для входа» под формой удаления аккаунта сбивал бы с толку
// ровно там, где человеку важно понимать, что он подтверждает. Общий код при
// этом не дыра — обе операции доказывают одно и то же, доступ к почте аккаунта,
// и у аккаунта с паролем к нему добавлен пароль.
func (s *Service) SendActionCode(ctx context.Context, user User) error {
	return s.issueCode(ctx, user, mail.TemplateAccountActionCode)
}

// SendLoginCode кладёт свежий код и письмо с ним — одной транзакцией.
// Предыдущий код при этом гаснет (UpsertLoginCode переписывает строку и
// обнуляет счётчик попыток): иначе «отправить ещё раз» копило бы валидные коды
// в чужом ящике.
func (s *Service) SendLoginCode(ctx context.Context, user User) error {
	return s.issueCode(ctx, user, mail.TemplateLoginCode)
}

// issueCode — общая механика обоих кодов: свежий код, его HMAC в базу и письмо
// одной транзакцией (transactional outbox).
func (s *Service) issueCode(ctx context.Context, user User, tpl mail.Template) error {
	if len(s.loginCodeKey) == 0 {
		return errLoginCodeNotConfigured
	}
	code, err := newLoginCode()
	if err != nil {
		return err
	}
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.UpsertLoginCode(ctx, tx, user.ID, hashLoginCode(s.loginCodeKey, code), time.Now().Add(loginCodeTTL)); err != nil {
			return err
		}
		return s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
			To:       user.Email,
			Template: tpl,
			Data:     map[string]any{"code": code},
		})
	})
}

// ResendLoginCode шлёт код заново — по подписанному пропуску второго шага, без
// сессии. Аккаунт с выключенным фактором отвечает ошибкой доступа, а не
// письмом: иначе ручка рассылала бы письма по чужим адресам, зная один id.
func (s *Service) ResendLoginCode(ctx context.Context, userID uuid.UUID) error {
	user, err := s.repo.GetUserByID(ctx, s.db, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrUnauthorized
		}
		return err
	}
	if !user.TwoFactorEnabled {
		return domain.ErrUnauthorized
	}
	return s.SendLoginCode(ctx, user)
}

// CompleteTwoFactorLogin — второй шаг входа: код принят, сессия открыта,
// браузер запомнен. Пользователя называет подписанная cookie, которую транспорт
// проверил до вызова; здесь остаётся проверить сам код.
//
// deviceToken возвращается транспорту, чтобы тот поставил cookie: пустым он не
// бывает — либо это токен, приехавший с запросом, либо только что выданный.
func (s *Service) CompleteTwoFactorLogin(ctx context.Context, userID uuid.UUID, code string, dev Device) (user User, sessionToken, deviceToken string, err error) {
	if err = s.consumeLoginCode(ctx, userID, code); err != nil {
		return User{}, "", "", err
	}
	user, err = s.repo.GetUserByID(ctx, s.db, userID)
	if err != nil {
		return User{}, "", "", err
	}
	if deviceToken, err = s.rememberDevice(ctx, userID, dev); err != nil {
		return User{}, "", "", err
	}
	if sessionToken, err = s.createSession(ctx, userID); err != nil {
		return User{}, "", "", err
	}
	return user, sessionToken, deviceToken, nil
}

// consumeLoginCode списывает попытку, сверяет код и гасит его при успехе.
//
// Мина: попытка списывается ДО сверки (условие живёт в самом UPDATE, см.
// ConsumeLoginCodeAttempt в queries.sql). Сверка первым шагом означала бы, что
// верный код проходит мимо исчерпанного счётчика, и перебор стоил бы ровно
// столько же, сколько без счётчика.
//
// Все отказы одинаковы (ErrInvalidCredentials): различать «код не тот», «код
// просрочен» и «попытки кончились» значит рассказывать перебирающему, где он
// оказался ближе.
func (s *Service) consumeLoginCode(ctx context.Context, userID uuid.UUID, code string) error {
	if len(s.loginCodeKey) == 0 {
		return errLoginCodeNotConfigured
	}
	stored, err := s.repo.ConsumeLoginCodeAttempt(ctx, s.db, userID, loginCodeMaxAttempts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrInvalidCredentials
		}
		return err
	}
	// hmac.Equal, а не ==: сравнение по времени не должно зависеть от того,
	// сколько первых байтов совпало.
	if !hmac.Equal(stored, hashLoginCode(s.loginCodeKey, code)) {
		return domain.ErrInvalidCredentials
	}
	// Код одноразовый: строки больше нет, повторное предъявление упрётся в
	// pgx.ErrNoRows выше.
	return s.repo.DeleteLoginCode(ctx, s.db, userID)
}

// rememberDevice заводит (или продлевает) знакомство с браузером. Токен из
// запроса переиспользуется, если он приехал: на одной машине может входить
// несколько аккаунтов, и второй cookie им не нужен — знакомство хранится
// строкой на пару «токен + аккаунт».
func (s *Service) rememberDevice(ctx context.Context, userID uuid.UUID, dev Device) (string, error) {
	token := dev.Token
	if token == "" {
		var err error
		if token, err = newDeviceToken(); err != nil {
			return "", err
		}
	}
	err := s.repo.CreateKnownDevice(ctx, s.db, domain.NewID(), userID,
		hashToken(token), deviceLabel(dev.UserAgent), time.Now().Add(knownDeviceTTL))
	if err != nil {
		return "", err
	}
	return token, nil
}

// DeviceInfo — строка списка устройств в настройках. Current помечает то, из
// которого человек смотрит на список: иначе «забыть» становится игрой в угадай.
type DeviceInfo struct {
	ID         uuid.UUID
	Label      string
	CreatedAt  time.Time
	LastSeenAt time.Time
	Current    bool
}

func (s *Service) ListDevices(ctx context.Context, userID uuid.UUID, dev Device) ([]DeviceInfo, error) {
	rows, err := s.repo.ListKnownDevices(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	var currentHash []byte
	if dev.Token != "" {
		currentHash = hashToken(dev.Token)
	}
	out := make([]DeviceInfo, 0, len(rows))
	for _, r := range rows {
		out = append(out, DeviceInfo{
			ID:         r.ID,
			Label:      r.Label,
			CreatedAt:  r.CreatedAt,
			LastSeenAt: r.LastSeenAt,
			Current:    currentHash != nil && hmac.Equal(currentHash, r.TokenHash),
		})
	}
	return out, nil
}

// ForgetDevice забывает одно устройство. Отсутствие строки — не ошибка:
// повторный клик из двух вкладок не авария.
func (s *Service) ForgetDevice(ctx context.Context, userID, deviceID uuid.UUID) error {
	_, err := s.repo.DeleteKnownDevice(ctx, s.db, deviceID, userID)
	return err
}

// ForgetAllDevices забывает все устройства И рвёт все сессии, кроме текущей.
//
// Мина: сессии здесь не «заодно». Кнопку жмут, когда подозревают чужого, а
// чужой сидит в живой сессии, которой второй фактор уже не мешает: забыть
// устройства и оставить его работать ещё до тридцати суток значит не сделать
// ничего.
func (s *Service) ForgetAllDevices(ctx context.Context, userID uuid.UUID, sessionToken string) error {
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.DeleteKnownDevicesByUser(ctx, tx, userID); err != nil {
			return err
		}
		return s.repo.DeleteSessionsByUserExcept(ctx, tx, userID, hashToken(sessionToken))
	})
}

// sessionOrChallenge — общий хвост всех путей входа: у аккаунта с включённым
// вторым фактором сессия выдаётся только знакомому браузеру, а незнакомому
// уходит код и возвращается ErrTwoFactorRequired.
//
// Один хелпер, а не проверка в каждом пути: забытая проверка в любом из путей
// входа означает дверь мимо второго фактора — то есть его отсутствие. Зовут
// его три пути — пароль, провайдер и разбор гонки; четвёртый, привязка паролем,
// разбирает фактор у себя, потому что обязан сделать это ДО создания привязки
// (см. LinkIdentityWithPassword).
func (s *Service) sessionOrChallenge(ctx context.Context, user User, dev Device) (User, string, error) {
	if user.TwoFactorEnabled {
		known, err := s.deviceKnown(ctx, user.ID, dev)
		if err != nil {
			return User{}, "", err
		}
		if !known {
			if err := s.SendLoginCode(ctx, user); err != nil {
				return User{}, "", err
			}
			return user, "", ErrTwoFactorRequired
		}
	}
	token, err := s.createSession(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
}

// deviceKnown отвечает «этот браузер уже предъявлял код» и одним запросом
// отмечает вход с него. Просроченное знакомство не считается — проверка срока
// живёт в самом UPDATE.
func (s *Service) deviceKnown(ctx context.Context, userID uuid.UUID, dev Device) (bool, error) {
	if dev.Token == "" {
		return false, nil
	}
	return s.repo.TouchKnownDevice(ctx, s.db, hashToken(dev.Token), userID)
}

// PurgeExpiredLoginCodes и PurgeExpiredKnownDevices — фоновая уборка (main.go).
// Освобождают место; на решения о доступе не влияют — срок проверяется в самих
// запросах.
func (s *Service) PurgeExpiredLoginCodes(ctx context.Context) (int64, error) {
	n, err := s.repo.DeleteExpiredLoginCodes(ctx, s.db)
	if err != nil {
		return 0, fmt.Errorf("purge expired login codes: %w", err)
	}
	return n, nil
}

func (s *Service) PurgeExpiredKnownDevices(ctx context.Context) (int64, error) {
	n, err := s.repo.DeleteExpiredKnownDevices(ctx, s.db)
	if err != nil {
		return 0, fmt.Errorf("purge expired known devices: %w", err)
	}
	return n, nil
}
