package legal

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Согласия аккаунта: гейт кабинета, экран «Завершение регистрации» или «Условия
// обновились», тумблер рассылок (docs/design/signup-consent.md §3.2–§3.5).

// Action — событие журнала. Значения совпадают с CHECK consent_events (0071).
type Action string

const (
	ActionAccepted  Action = "accepted"
	ActionWithdrawn Action = "withdrawn"
)

// Source — где человек дал или отозвал согласие. Значения совпадают с CHECK
// consent_events (0071).
type Source string

const (
	SourceSignupPassword Source = "signup_password"
	// SourceSignupYandex — регистрация аккаунта без пароля. Провайдер входа сейчас один;
	// второй провайдер добавит свой источник, иначе журнал назовёт его Яндексом.
	SourceSignupYandex Source = "signup_yandex"
	SourceUpdateScreen Source = "update_screen"
	SourceSettings     Source = "settings"
	// SourceSeed — фикстуры: сидер dev-контура и тесты модулей.
	SourceSeed Source = "seed"
)

// Подписи галочек и тумблера. Отдаёт их сервер, и тот же текст ложится в журнал —
// поэтому подпись, которую видел человек, восстанавливается без кода кабинета на ту дату.
// Link — часть подписи, которая становится ссылкой на документ.
const (
	termsLabel           = "Принимаю Пользовательское соглашение"
	termsLink            = "Пользовательское соглашение"
	marketingLabel       = "Даю согласие на получение новостей и предложений Trillix"
	marketingLink        = "согласие"
	marketingToggleLabel = "Новости и предложения Trillix"
)

// maxUserAgentRunes — потолок описания браузера в журнале: заголовок присылает клиент.
const maxUserAgentRunes = 512

// Actor — чей запрос: снимок аккаунта на момент события.
type Actor struct {
	UserID    uuid.UUID
	Email     string
	UserAgent string
	// HasPassword — false у аккаунта, заведённого через провайдера входа.
	HasPassword     bool
	SignupCompleted bool
}

// Screen — какой экран согласия закрывает кабинет.
type Screen string

const (
	ScreenNone   Screen = ""
	ScreenSignup Screen = "signup"
	ScreenUpdate Screen = "update"
)

// Offer — действующая редакция документа с подписью галочки.
type Offer struct {
	Edition Edition
	Label   string
	Link    string
}

// TermsState — соглашение: действующая редакция и последняя принятая.
type TermsState struct {
	Offer
	AcceptedVersion string // "" — не принималось ни разу
	AcceptedAt      *time.Time
}

// MarketingState — согласие на рассылки: действующая редакция и текущее решение.
type MarketingState struct {
	Offer
	ToggleLabel    string
	Granted        bool
	GrantedVersion string // редакция, на которую дано действующее согласие
	ChangedAt      *time.Time
}

// View — согласия аккаунта целиком: экран, документы, история.
type View struct {
	Screen    Screen
	Terms     *TermsState     // nil — ни одна редакция не вступила в силу
	Marketing *MarketingState // nil — то же
	History   []HistoryItem
}

// DocRef — документ и редакция, которую человек видел на экране.
type DocRef struct {
	Kind    Kind
	Version string
}

// Change — что человек принимает и что отзывает одним действием.
type Change struct {
	Accept   []DocRef
	Withdraw []Kind
}

// ConsentRequired — гейт кабинета: не принята редакция соглашения не старше последней
// существенной.
func (s *Service) ConsentRequired(ctx context.Context, userID uuid.UUID) (bool, error) {
	return s.repo.TermsAcceptanceMissing(ctx, s.db, userID, s.now())
}

// State — согласия аккаунта для экрана согласия и «Правовой информации».
func (s *Service) State(ctx context.Context, actor Actor) (View, error) {
	return s.view(ctx, actor)
}

func (s *Service) view(ctx context.Context, actor Actor) (View, error) {
	now := s.now()
	missing, err := s.repo.TermsAcceptanceMissing(ctx, s.db, actor.UserID, now)
	if err != nil {
		return View{}, err
	}
	latest, err := s.latest(ctx, actor.UserID)
	if err != nil {
		return View{}, err
	}
	var v View
	if missing {
		v.Screen = ScreenUpdate
		if !actor.SignupCompleted {
			v.Screen = ScreenSignup
		}
	}

	terms, ok, err := s.current(ctx, KindTerms, now)
	if err != nil {
		return View{}, err
	}
	if ok {
		st := &TermsState{Offer: Offer{Edition: terms, Label: termsLabel, Link: termsLink}}
		if ev, has := latest[KindTerms]; has {
			at := ev.At
			st.AcceptedVersion, st.AcceptedAt = ev.Version, &at
		}
		v.Terms = st
	}

	marketing, ok, err := s.current(ctx, KindMarketing, now)
	if err != nil {
		return View{}, err
	}
	if ok {
		st := &MarketingState{
			Offer:       Offer{Edition: marketing, Label: marketingLabel, Link: marketingLink},
			ToggleLabel: marketingToggleLabel,
		}
		if ev, has := latest[KindMarketing]; has {
			at := ev.At
			st.ChangedAt = &at
			if ev.Action == ActionAccepted {
				st.Granted, st.GrantedVersion = true, ev.Version
			}
		}
		v.Marketing = st
	}

	if v.History, err = s.repo.History(ctx, s.db, actor.UserID); err != nil {
		return View{}, err
	}
	return v, nil
}

// Apply принимает и отзывает согласия одним действием. Повтор уже действующего решения
// событий не пишет. Первое принятие соглашения ставит отметку о завершении регистрации
// той же транзакцией.
func (s *Service) Apply(ctx context.Context, actor Actor, change Change) (View, error) {
	if len(change.Accept)+len(change.Withdraw) == 0 {
		return View{}, fmt.Errorf("%w: не выбрано ни одного документа", domain.ErrValidation)
	}
	now := s.now()
	latest, err := s.latest(ctx, actor.UserID)
	if err != nil {
		return View{}, err
	}

	named := map[Kind]bool{}
	var (
		events      []ConsentEvent
		acceptTerms bool
		acceptsMkt  bool
	)
	for _, ref := range change.Accept {
		if ref.Kind != KindTerms && ref.Kind != KindMarketing {
			return View{}, fmt.Errorf("%w: принять можно только соглашение и согласие на рассылки", domain.ErrValidation)
		}
		if named[ref.Kind] {
			return View{}, fmt.Errorf("%w: документ назван дважды", domain.ErrValidation)
		}
		named[ref.Kind] = true
		cur, ok, err := s.current(ctx, ref.Kind, now)
		if err != nil {
			return View{}, err
		}
		if !ok {
			return View{}, fmt.Errorf("%w: у документа нет действующей редакции", domain.ErrValidation)
		}
		// Экран открыт до публикации новой редакции: человек соглашался не с ней.
		if cur.Version != ref.Version {
			return View{}, fmt.Errorf("%w: редакция документа обновилась — обновите страницу", domain.ErrValidation)
		}
		if ref.Kind == KindTerms {
			acceptTerms = true
		} else {
			acceptsMkt = true
		}
		if ev, has := latest[ref.Kind]; has && ev.Action == ActionAccepted && ev.DocumentID == cur.ID {
			continue
		}
		events = append(events, s.event(actor, cur.ID, ref.Kind, ActionAccepted))
	}
	for _, kind := range change.Withdraw {
		if kind != KindMarketing {
			return View{}, fmt.Errorf("%w: отозвать можно только согласие на рассылки", domain.ErrValidation)
		}
		if named[kind] {
			return View{}, fmt.Errorf("%w: документ назван дважды", domain.ErrValidation)
		}
		named[kind] = true
		ev, has := latest[kind]
		if !has || ev.Action != ActionAccepted {
			continue
		}
		// Отзывается то согласие, которое действует, — его редакция и пишется в событие.
		events = append(events, s.event(actor, ev.DocumentID, kind, ActionWithdrawn))
	}

	if acceptsMkt && !acceptTerms {
		missing, err := s.repo.TermsAcceptanceMissing(ctx, s.db, actor.UserID, now)
		if err != nil {
			return View{}, err
		}
		if missing {
			return View{}, fmt.Errorf("%w: сначала примите Пользовательское соглашение", domain.ErrValidation)
		}
	}

	markSignup := acceptTerms && !actor.SignupCompleted
	if len(events) > 0 || markSignup {
		err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
			for _, e := range events {
				if err := s.repo.InsertEvent(ctx, tx, e); err != nil {
					return err
				}
			}
			if markSignup {
				return s.accounts.MarkSignupCompleted(ctx, tx, actor.UserID)
			}
			return nil
		})
		if err != nil {
			return View{}, err
		}
	}
	actor.SignupCompleted = actor.SignupCompleted || acceptTerms
	return s.view(ctx, actor)
}

// AcceptForSeed принимает действующую редакцию соглашения за фикстуру — сидер dev-контура
// и тесты модулей — с источником seed и завершает регистрацию.
func (s *Service) AcceptForSeed(ctx context.Context, userID uuid.UUID, email string) error {
	cur, ok, err := s.current(ctx, KindTerms, s.now())
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("legal: у соглашения нет действующей редакции")
	}
	latest, err := s.latest(ctx, userID)
	if err != nil {
		return err
	}
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if ev, has := latest[KindTerms]; !has || ev.DocumentID != cur.ID {
			err := s.repo.InsertEvent(ctx, tx, ConsentEvent{
				UserID: userID, DocumentID: cur.ID, Action: ActionAccepted, Source: SourceSeed,
				CheckboxText: termsLabel, Email: email,
			})
			if err != nil {
				return err
			}
		}
		return s.accounts.MarkSignupCompleted(ctx, tx, userID)
	})
}

// event собирает строку журнала: источник и подпись выводятся из того, где человек
// находится. До завершения регистрации это экран регистрации; после — экран новой
// редакции для соглашения и тумблер для рассылок.
func (s *Service) event(actor Actor, documentID uuid.UUID, kind Kind, action Action) ConsentEvent {
	e := ConsentEvent{
		UserID: actor.UserID, DocumentID: documentID, Action: action,
		Email: actor.Email, UserAgent: clipRunes(actor.UserAgent, maxUserAgentRunes),
	}
	switch {
	case !actor.SignupCompleted && actor.HasPassword:
		e.Source = SourceSignupPassword
	case !actor.SignupCompleted:
		e.Source = SourceSignupYandex
	case kind == KindTerms:
		e.Source = SourceUpdateScreen
	default:
		e.Source = SourceSettings
	}
	switch {
	case kind == KindTerms:
		e.CheckboxText = termsLabel
	case e.Source == SourceSettings || action == ActionWithdrawn:
		e.CheckboxText = marketingToggleLabel
	default:
		e.CheckboxText = marketingLabel
	}
	return e
}

func (s *Service) current(ctx context.Context, kind Kind, now time.Time) (Edition, bool, error) {
	ed, err := s.repo.GetCurrent(ctx, s.db, kind, now)
	if errors.Is(err, pgx.ErrNoRows) {
		return Edition{}, false, nil
	}
	if err != nil {
		return Edition{}, false, fmt.Errorf("current legal document %s: %w", kind, err)
	}
	return ed, true, nil
}

func (s *Service) latest(ctx context.Context, userID uuid.UUID) (map[Kind]LatestEvent, error) {
	events, err := s.repo.LatestEvents(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[Kind]LatestEvent, len(events))
	for _, e := range events {
		out[e.Kind] = e
	}
	return out, nil
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
