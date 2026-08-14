package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
)

// ErrPasswordLinkRequired — вход через провайдера пришёлся на email, под которым
// уже есть аккаунт, а привязки к провайдеру нет. Сессия не выдаётся: провайдеры
// не сообщают, подтверждён ли адрес (DEV-PLAN фаза 11 шаг 1), поэтому совпадение
// email доказательством владения аккаунтом не является. Доступ получает только
// тот, кто введёт пароль, — ADR §10.
//
// Не доменная ошибка: наружу она едет не HTTP-статусом, а редиректом на экран
// привязки, и маппинга в respond.go у неё нет.
var ErrPasswordLinkRequired = errors.New("auth: требуется вход паролем для привязки провайдера")

// ErrProviderOnlyAccount — адрес занят аккаунтом без пароля, а пришли мы с
// другой личностью у провайдера (например, аккаунт у провайдера удалён и заведён
// заново — идентификатор новый, адрес прежний). Просить пароль нельзя: его нет.
// Автоматически привязать новую личность тоже нельзя — это ровно то
// автосвязывание по email, которое запрещено ADR §10.
//
// Выход появится со сбросом пароля по почте (следующая фаза): человек, владеющий
// адресом, задаст пароль и привяжет новую личность сам. До тех пор случай
// разбирается руками — TD-34.
var ErrProviderOnlyAccount = errors.New("auth: аккаунт доступен только через прежнего провайдера")

// IdentityProfile — то, что провайдер рассказал о пришедшем человеке, в виде,
// понятном сервису (пакет oauth сюда не импортируется: слой не должен зависеть
// от того, откуда именно приехали эти строки).
//
// Структурой, а не шестью строковыми аргументами подряд: email, имя и фамилия
// одного типа, и перепутанные местами при вызове они не вызовут ни ошибки
// компиляции, ни падения теста — просто человека будут звать своим адресом.
type IdentityProfile struct {
	Provider       string
	ProviderUserID string
	Email          string
	// FirstName/LastName — необязательны и могут быть пустыми (провайдер не
	// отдал). Пустые ничего не перетирают.
	FirstName string
	LastName  string
}

// LoginWithIdentity — вход через внешнего провайдера.
//
// Три исхода: привязка найдена — вход; аккаунта с таким email нет — заводим
// новый без пароля; аккаунт есть, привязки нет — ErrPasswordLinkRequired.
// Автосвязывания нет ни при каких условиях.
func (s *Service) LoginWithIdentity(ctx context.Context, p IdentityProfile) (User, string, error) {
	email := normalizeEmail(p.Email)

	user, err := s.repo.GetUserByIdentity(ctx, s.db, p.Provider, p.ProviderUserID)
	switch {
	case err == nil:
		// Профиль дозаполняется на КАЖДОМ входе, но только пустые поля: у
		// аккаунта, заведённого до фазы 23, имени нет, и первый же вход через
		// Яндекс его проставит. Затирать введённое руками нельзя — иначе правка
		// имени в кабинете живёт до следующего входа.
		user, err = s.fillProfileFromProvider(ctx, user, p)
		if err != nil {
			return User{}, "", err
		}
		// Адрес у провайдера, наоборот, ОСВЕЖАЕТСЯ: он подписывает карточку на
		// экране настроек, и устаревший там хуже отсутствующего.
		if p.Email != "" {
			if e := s.repo.SetIdentityEmail(ctx, s.db, p.Provider, p.ProviderUserID, email); e != nil {
				return User{}, "", e
			}
		}
		// Второй фактор применяется и к входу через провайдера: иначе он
		// обходится в один клик, то есть не существует (слайс F).
		return s.sessionOrChallenge(ctx, user)
	case !errors.Is(err, pgx.ErrNoRows):
		return User{}, "", err
	}

	// Привязки нет. Занят ли адрес?
	switch existing, err := s.repo.GetUserByEmail(ctx, s.db, email); {
	case err == nil:
		// Пароля у занявшего адрес аккаунта нет — на экране привязки доказывать
		// владение будет нечем, туда его вести нельзя.
		if existing.PasswordHash == nil {
			return User{}, "", ErrProviderOnlyAccount
		}
		return User{}, "", ErrPasswordLinkRequired
	case !errors.Is(err, pgx.ErrNoRows):
		return User{}, "", err
	}

	user, err = s.createUserWithIdentity(ctx, email, p)
	if err != nil {
		if errors.Is(err, errConcurrentSignup) {
			// Тот же адрес завели параллельно — почти всегда это тот же человек
			// в двух вкладках. Соседняя транзакция уже создала и аккаунт, и
			// привязку, поэтому повторный поиск даёт вход, а не тупик.
			return s.resolveAfterRace(ctx, p, email)
		}
		return User{}, "", err
	}
	token, err := s.createSession(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
}

// errConcurrentSignup — внутренний маркер гонки при создании аккаунта.
var errConcurrentSignup = errors.New("auth: аккаунт с этим email создан параллельно")

// resolveAfterRace разбирает исход гонки: привязка соседней транзакции — вход;
// иначе адрес занят кем-то ещё, и работают обычные правила.
func (s *Service) resolveAfterRace(ctx context.Context, p IdentityProfile, email string) (User, string, error) {
	user, err := s.repo.GetUserByIdentity(ctx, s.db, p.Provider, p.ProviderUserID)
	if err == nil {
		return s.sessionOrChallenge(ctx, user)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", err
	}

	existing, err := s.repo.GetUserByEmail(ctx, s.db, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Ни привязки, ни видимого аккаунта, а вставка упёрлась в UNIQUE —
			// значит адрес держит УДАЛЁННЫЙ аккаунт (слайс G): для чтений он
			// невидим, а email занимает. Ответ тот же, что при регистрации на
			// занятый адрес, — нового о чужом аккаунте он не сообщает.
			return User{}, "", domain.ErrEmailTaken
		}
		return User{}, "", err
	}
	if existing.PasswordHash == nil {
		return User{}, "", ErrProviderOnlyAccount
	}
	return User{}, "", ErrPasswordLinkRequired
}

// LinkIdentityWithPassword привязывает провайдера к существующему аккаунту после
// проверки пароля — второй шаг сценария ErrPasswordLinkRequired.
//
// Пароль здесь проверяется ровно как в Login, включая выравнивание времени:
// эндпоинт принимает пароль, значит он ещё одна дверь для перебора и обязан
// вести себя как основная.
// Имя провайдера здесь не проставляется, и это не упущение: на этом шаге его
// физически нет. Профиль читается на колбэке, а до сюда доезжает только
// подписанная cookie с парой (провайдер, идентификатор) — класть в неё ещё и
// ФИО значит возить чужие ПДн через браузер ради поля, которое всё равно
// приедет на ближайшем входе через того же провайдера.
//
// У аккаунта с включённым вторым фактором code обязателен: пустой даёт
// ErrTwoFactorRequired, и транспорт просит код той же формой. Мина: привязка
// создаётся ПОСЛЕ проверки кода, а не до неё. Иначе знающий пароль, но не
// знающий кода прицепляет свою личность у провайдера к чужому аккаунту —
// ровно та атака, ради которой intent=link держат в подписанной cookie
// (design/account-settings.md, §9), только зашедшая с другой стороны.
func (s *Service) LinkIdentityWithPassword(ctx context.Context, email, password, code, provider, providerUserID string) (User, string, error) {
	email = normalizeEmail(email)

	user, err := s.repo.GetUserByEmail(ctx, s.db, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			equalizeTiming(password)
			return User{}, "", domain.ErrInvalidCredentials
		}
		return User{}, "", err
	}
	// Аккаунт без пароля привязать паролем нельзя: доказывать нечем.
	if user.PasswordHash == nil {
		equalizeTiming(password)
		return User{}, "", domain.ErrInvalidCredentials
	}
	ok, err := VerifyPassword(*user.PasswordHash, password)
	if err != nil {
		return User{}, "", err
	}
	if !ok {
		return User{}, "", domain.ErrInvalidCredentials
	}

	enabled, err := s.TwoFactorEnabled(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	if enabled {
		if code == "" {
			return user, "", ErrTwoFactorRequired
		}
		if err := s.consumeSecondFactor(ctx, user.ID, code); err != nil {
			return User{}, "", err
		}
	}

	if err := s.repo.CreateIdentity(ctx, s.db, provider, providerUserID, user.ID, ""); err != nil {
		// Тот же аккаунт провайдера уже привязан (к этому пользователю или к
		// другому) — повторный клик по «привязать» не должен выглядеть аварией.
		if isUniqueViolation(err) {
			return User{}, "", fmt.Errorf("%w: этот аккаунт провайдера уже привязан", domain.ErrConflict)
		}
		return User{}, "", err
	}

	// sessionOrChallenge здесь не зовётся: второй фактор уже разобран выше, до
	// побочного эффекта. Повторный вызов потребовал бы второй код на тот же вход.
	token, err := s.createSession(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
}

// fillProfileFromProvider проставляет имя из профиля провайдера, НЕ трогая уже
// заполненное. Пустой профиль (провайдер имени не отдал) — не повод для запроса
// в базу вовсе.
func (s *Service) fillProfileFromProvider(ctx context.Context, user User, p IdentityProfile) (User, error) {
	first, last := providerName(p.FirstName), providerName(p.LastName)
	if first == nil && last == nil {
		return user, nil
	}
	return s.repo.FillEmptyProfile(ctx, s.db, user.ID, first, last)
}

// providerName приводит имя из чужого профиля к тому, что можно положить в
// колонку: пустое и негодное — nil.
//
// Негодное здесь именно ИГНОРИРУЕТСЯ, а не отвергает запрос: имя приезжает
// побочным эффектом входа, и отказать человеку войти из-за того, что у него в
// профиле Яндекса 300 символов, было бы обменом рабочего входа на украшение.
// В форме кабинета то же значение даст честные 422 — там его печатает человек.
func providerName(v string) *string {
	name, err := normalizePersonName(v, "имя")
	if err != nil {
		return nil
	}
	return name
}

// createUserWithIdentity заводит пользователя без пароля вместе с личным
// воркспейсом и привязкой — одной транзакцией. Инвариант «регистрация = user +
// workspace + membership» (internal/CLAUDE.md) распространяется и на этот путь:
// аккаунт без воркспейса нерабочий, а привязка без аккаунта — мусор.
func (s *Service) createUserWithIdentity(ctx context.Context, email string, p IdentityProfile) (User, error) {
	userID := domain.NewID()
	wsID := domain.NewID()

	var user User
	err := s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		u, e := s.repo.CreateUser(ctx, tx, userID, email, nil)
		if e != nil {
			if isUniqueViolation(e) {
				// Гонка: тот же email завели между нашей проверкой и вставкой.
				// Разбирает её вызывающий — здесь только маркер.
				return errConcurrentSignup
			}
			return e
		}
		user = u
		// Имя ставится ТОЙ ЖЕ транзакцией, что и аккаунт: отдельным запросом
		// после коммита оно потерялось бы при любом сбое между ними, и человек
		// увидел бы пустой профиль там, где провайдер имя отдал.
		if first, last := providerName(p.FirstName), providerName(p.LastName); first != nil || last != nil {
			filled, e := s.repo.FillEmptyProfile(ctx, tx, userID, first, last)
			if e != nil {
				return e
			}
			user = filled
		}
		if _, e := s.repo.CreateWorkspace(ctx, tx, wsID, personalWorkspaceName, userID); e != nil {
			return e
		}
		if e := s.repo.AddWorkspaceMember(ctx, tx, wsID, userID, roleOwner); e != nil {
			return e
		}
		if e := s.repo.CreateSubscription(ctx, tx, userID, defaultPlanCode); e != nil {
			return e
		}
		if e := s.repo.CreateIdentity(ctx, tx, p.Provider, p.ProviderUserID, userID, email); e != nil {
			return e
		}
		// Вход через провайдера считаем подтверждением email: чтобы завести аккаунт
		// у провайдера, надо владеть его почтой, а аутентификация доказывает контроль
		// над этим аккаунтом. Флаг гасит баннер «подтвердите почту» — он остаётся
		// только парольным регистрациям, где адрес вводят руками (и можно опечататься).
		// Это не противоречит запрету автосвязывания по email (ADR §10): там речь про
		// слияние с чужим паролным аккаунтом, здесь — про собственный адрес.
		return s.repo.MarkEmailVerified(ctx, tx, userID)
	})
	if err != nil {
		return User{}, err
	}
	// Отражаем отметку в возвращаемой структуре (в БД её проставил MarkEmailVerified
	// через now()): первый же ответ /auth/* после входа несёт emailVerified=true.
	verifiedAt := time.Now()
	user.EmailVerifiedAt = &verifiedAt
	return user, nil
}
