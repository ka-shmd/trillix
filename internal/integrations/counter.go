package integrations

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Счётчики аналитики автора на форме (фаза 29 DEV-PLAN, спека
// docs/design/yandex-metrika.md §4). В отличие от вебхука это не цель доставки:
// ответы никуда не едут, номер нужен странице формы, чтобы запустить счётчик у
// респондента, и загрузчику встраивания, чтобы отметить цель в счётчике сайта.

// CounterYandexMetrika — вид счётчика в form_counters.kind. Зеркалит CHECK
// form_counters_kind_check миграции 0067.
const CounterYandexMetrika = "yandex_metrika"

// counterNumberRe — номер счётчика: цифры без ведущего нуля, не длиннее 12.
// Зеркалит CHECK form_counters_counter_check миграции 0067: разойдутся — неверный
// номер уедет в базу и упадёт там 500-й вместо человеческого 422.
var counterNumberRe = regexp.MustCompile(`^[1-9][0-9]{0,11}$`)

// Counter — счётчик формы.
type Counter struct {
	Kind    string
	Number  string
	Enabled bool
}

// CounterInput — что автор ввёл в окне счётчика.
type CounterInput struct {
	Number  string
	Enabled bool
}

// CounterStore — данные счётчиков. Отдельно от Store и WebhookStore по той же
// причине, что WebhookStore: у видов интеграций свои фейки в тестах. Реализация — Repo.
type CounterStore interface {
	UpsertCounter(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, kind, number string, enabled bool) error
	// GetCounter возвращает pgx.ErrNoRows, если счётчик вида у формы не подключён.
	GetCounter(ctx context.Context, db postgres.DBTX, formID uuid.UUID, kind string) (Counter, error)
	DeleteCounter(ctx context.Context, db postgres.DBTX, formID uuid.UUID, kind string) (int64, error)
}

var _ CounterStore = Repo{}

// WithCounters подключает счётчики аналитики. nil — сборка без счётчиков: ручки
// отвечают 404, в состоянии таба счётчика нет.
//
// formBaseURL — адрес публичного рендерера: из его хоста берётся «сайт» счётчика,
// который продукт заводит в Метрике. Пусто — создание счётчика недоступно, всё
// остальное работает.
func (s *Service) WithCounters(store CounterStore, formBaseURL string) *Service {
	s.counters = store
	s.formBase = formBaseURL
	return s
}

// metrikaCounterName — имя счётчика, который заводит продукт. Название формы в
// нём обязательно: счётчиков у автора десяток, и «Trillix» без уточнения через
// месяц не отличить от «Trillix» соседней формы.
func metrikaCounterName(form forms.Form) string {
	name := form.Title
	if form.Name != nil && *form.Name != "" {
		name = *form.Name
	}
	if strings.TrimSpace(name) == "" {
		name = "Форма"
	}
	return "Trillix: " + name
}

// CreateMetrikaCounter заводит в аккаунте новый счётчик, ставит его форме и
// создаёт цели — одним действием. name — имя счётчика от автора; пустое —
// имя по умолчанию (metrikaCounterName).
//
// Действие одно, потому что по отдельности его половинки бессмысленны: счётчик
// без номера у формы не работает, а номер без целей не отмечает ничего. Права и
// порядок проверок те же, что у заведения целей: форма — раньше похода в Яндекс.
func (s *Service) CreateMetrikaCounter(ctx context.Context, userID, formID, accountID uuid.UUID, name string) (Counter, GoalsResult, error) {
	if s.counters == nil || s.yandex == nil || s.formBase == "" {
		return Counter{}, GoalsResult{}, domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return Counter{}, GoalsResult{}, err
	}
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > MaxConnectionNameLen {
		return Counter{}, GoalsResult{}, fmt.Errorf("%w: название счётчика длиннее %d символов", domain.ErrValidation, MaxConnectionNameLen)
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return Counter{}, GoalsResult{}, err
	}
	if name == "" {
		name = metrikaCounterName(form)
	}
	conn, err := s.accountOfProvider(ctx, ProviderYandex, userID, accountID)
	if err != nil {
		return Counter{}, GoalsResult{}, err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return Counter{}, GoalsResult{}, metrikaRefusal(ctx, err)
	}
	created, err := s.yandex.CreateCounter(ctx, token, name, formSite(s.formBase))
	if err != nil {
		return Counter{}, GoalsResult{}, metrikaRefusal(ctx, err)
	}
	number := strconv.FormatInt(created.ID, 10)
	// Номер сохраняется РАНЬШЕ целей: счётчик в Метрике уже существует, и потеряв
	// его номер, человек получит бесхозный счётчик и никакого способа связать его
	// с формой, кроме как завести ещё один.
	if err := s.counters.UpsertCounter(ctx, s.db, domain.NewID(), formID, CounterYandexMetrika, number, true); err != nil {
		return Counter{}, GoalsResult{}, fmt.Errorf("set counter: %w", err)
	}
	counter := Counter{Kind: CounterYandexMetrika, Number: number, Enabled: true}
	res, err := s.yandex.EnsureGoals(ctx, token, created.ID, metrikaGoals)
	if err != nil {
		return counter, GoalsResult{}, metrikaRefusal(ctx, err)
	}
	return counter, res, nil
}

// formSite — «сайт» заводимого счётчика: хост страниц форм без порта. Порт
// Метрика в сайте не ждёт, а на dev он есть.
func formSite(base string) string {
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" {
		return base
	}
	return u.Hostname()
}

// SetCounter подключает к форме счётчик вида kind или правит номер и тумблер
// подключённого (тумблер строки шлёт тот же номер). Тариф здесь не спрашивается:
// сохраняется намерение автора, а право на счётчик проверяется при отдаче формы
// (спека §5).
//
// Номер проверяется ПОСЛЕ права на форму: постороннему отвечает 404, а не отказ по
// вводу.
func (s *Service) SetCounter(ctx context.Context, userID, formID uuid.UUID, kind string, in CounterInput) (Counter, error) {
	if s.counters == nil {
		return Counter{}, domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return Counter{}, err
	}
	if !counterNumberRe.MatchString(in.Number) {
		return Counter{}, fmt.Errorf("%w: номер счётчика — от 1 до 12 цифр, как в настройках Метрики", domain.ErrValidation)
	}
	if err := s.counters.UpsertCounter(ctx, s.db, domain.NewID(), formID, kind, in.Number, in.Enabled); err != nil {
		return Counter{}, fmt.Errorf("set counter: %w", err)
	}
	return Counter{Kind: kind, Number: in.Number, Enabled: in.Enabled}, nil
}

// DeleteCounter снимает с формы счётчик вида kind.
func (s *Service) DeleteCounter(ctx context.Context, userID, formID uuid.UUID, kind string) error {
	if s.counters == nil {
		return domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	n, err := s.counters.DeleteCounter(ctx, s.db, formID, kind)
	if err != nil {
		return fmt.Errorf("delete counter: %w", err)
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// formCounter — счётчик вида kind для состояния таба; nil — не подключён. Номер не
// секрет (он виден в коде любой страницы со счётчиком), поэтому приходит всем, кто
// видит форму.
func (s *Service) formCounter(ctx context.Context, formID uuid.UUID, kind string) (*Counter, error) {
	if s.counters == nil {
		return nil, nil
	}
	c, err := s.counters.GetCounter(ctx, s.db, formID, kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// Счётчики и цели через подключённый аккаунт Яндекса (спека §13.3–13.4). Номер
// счётчика по-прежнему основа: сюда приходят, чтобы взять его из списка вместо
// переписывания из чужой вкладки и завести цели, — сохраняется он тем же
// SetCounter.

// MetrikaCounters — счётчики аккаунта Яндекса, цели которых он вправе заводить.
//
// Прав пространства не спрашивает, как и список таблиц Google: аккаунт свой, и
// раскрывать в нём человеку нечего.
func (s *Service) MetrikaCounters(ctx context.Context, userID, accountID uuid.UUID) ([]MetrikaCounter, error) {
	if s.yandex == nil {
		return nil, domain.ErrNotFound
	}
	conn, err := s.accountOfProvider(ctx, ProviderYandex, userID, accountID)
	if err != nil {
		return nil, err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return nil, metrikaRefusal(ctx, err)
	}
	list, err := s.yandex.ListCounters(ctx, token)
	if err != nil {
		return nil, metrikaRefusal(ctx, err)
	}
	return list, nil
}

// EnsureMetrikaGoals заводит в счётчике формы недостающие цели продукта.
//
// Порядок проверок обязателен: право на форму — ПЕРВЫМ, до похода в Яндекс.
// Иначе посторонний по id чужой формы получал бы отказ Яндекса вместо 404, то
// есть узнавал бы и о существовании формы, и о том, что у неё есть счётчик.
//
// Счётчик берётся у формы, а не из тела запроса: цели заводятся тому номеру,
// который реально стоит на странице, — иначе они уехали бы в счётчик, который
// формы не видит.
func (s *Service) EnsureMetrikaGoals(ctx context.Context, userID, formID, accountID uuid.UUID) (GoalsResult, error) {
	if s.counters == nil || s.yandex == nil {
		return GoalsResult{}, domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return GoalsResult{}, err
	}
	c, err := s.formCounter(ctx, formID, CounterYandexMetrika)
	if err != nil {
		return GoalsResult{}, fmt.Errorf("form counter: %w", err)
	}
	if c == nil {
		return GoalsResult{}, fmt.Errorf("%w: у формы нет счётчика — сначала подключите его", domain.ErrValidation)
	}
	// Номер в базе прошёл counterNumberRe (до 12 цифр), поэтому в int64 влезает.
	number, err := strconv.ParseInt(c.Number, 10, 64)
	if err != nil {
		return GoalsResult{}, fmt.Errorf("counter number %q: %w", c.Number, err)
	}
	conn, err := s.accountOfProvider(ctx, ProviderYandex, userID, accountID)
	if err != nil {
		return GoalsResult{}, err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return GoalsResult{}, metrikaRefusal(ctx, err)
	}
	res, err := s.yandex.EnsureGoals(ctx, token, number, metrikaGoals)
	if err != nil {
		return GoalsResult{}, metrikaRefusal(ctx, err)
	}
	return res, nil
}

// metrikaRefusal переводит окончательный отказ Яндекса в текст для человека.
//
// Сам текст Яндекса до экрана не доезжает: он английский, а на экране человеку
// нужно действие, а не «Access is denied». В лог он уходит целиком — отладка
// иначе свелась бы к трёхзначному числу.
//
// Всё, кроме окончательного отказа (сеть, пятисотка Яндекса), едет как есть:
// это «повторите», а не «почините доступ».
func metrikaRefusal(ctx context.Context, err error) error {
	if !errors.Is(err, ErrPermanent) {
		return err
	}
	httpserver.LoggerFrom(ctx).Warn("metrika refused", slog.String("error", err.Error()))
	if errors.Is(err, ErrAccessLost) {
		return fmt.Errorf("%w: доступ к аккаунту Яндекса отозван — подключите аккаунт заново", domain.ErrValidation)
	}
	return fmt.Errorf("%w: Яндекс не дал доступа к счётчику — проверьте, что аккаунт вправе его править", domain.ErrValidation)
}
