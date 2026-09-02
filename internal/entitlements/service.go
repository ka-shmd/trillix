package entitlements

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// moscow — расчётный часовой пояс периода (решение владельца: «лимит обнуляется
// 1-го числа» объяснимо пользователю одной фразой).
//
// FixedZone, а НЕ time.LoadLocation("Europe/Moscow"): загрузка зоны по имени
// требует базы tzdata в образе, которой в scratch/distroless нет — падение
// случилось бы на проде и только там. Москва живёт на UTC+3 без переходов с
// 2014 года; появится перевод часов — здесь будет одна строка и тест.
var moscow = time.FixedZone("MSK", 3*60*60)

// Row — состояние тарифа воркспейса на конкретный период (одна поездка в БД).
type Row struct {
	PlanCode  string
	PlanTitle string
	Limits    []byte // plans.limits как есть
	// SubmissionsUsed — расход за период (0, если строки usage ещё нет).
	SubmissionsUsed int64
	// WorkspacesOwned — сколько пространств аккаунт держит СЕЙЧАС (счётчик
	// аккаунт-уровневых ключей; у воркспейс-уровневых строк всегда 0).
	WorkspacesOwned int64
	// MembersCount — сколько человек в пространстве СЕЙЧАС. Считается только
	// там, где спрашивают про места: приём ответа за этим не ходит.
	MembersCount int64
	// StorageUsed — сколько байт файлов ответов уже лежит в пространстве. Как и
	// MembersCount, считается только там, где спрашивают: приём ответа и выдача
	// картинок за этим не ходят.
	StorageUsed int64
	// AIGenerationsUsed — сколько раз за период форму собирали или правили текстом.
	// Читается из той же строки usage, что и SubmissionsUsed, поэтому отдельного
	// запроса (как у мест и хранилища) ему не нужно: колонка соседняя.
	AIGenerationsUsed int64
}

// Store — доступ к данным, объявленный на стороне потребителя. Реализация — Repo.
type Store interface {
	Entitlements(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) (Row, error)
	// EntitlementsForUser — то же с проверкой членства ВНУТРИ запроса: у снимка
	// для кабинета есть пользователь, и id воркспейса из URL правом доступа не
	// является (инвариант 1).
	EntitlementsForUser(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, period time.Time) (Row, error)
	// AccountEntitlements — план самого аккаунта и его счётчики. Периода нет:
	// аккаунт-уровневое считается «здесь и сейчас», а не за расчётный месяц.
	AccountEntitlements(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (Row, error)
	// EntitlementsWithStorage — то же, что Entitlements, плюс расход хранилища
	// (гейт файлов). Отдельным запросом по тому же доводу, что и счётчик
	// участников: сумма по submission_files нужна одной операции.
	EntitlementsWithStorage(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) (Row, error)
	// EntitlementsWithMembers — то же, что Entitlements, плюс счётчик участников.
	// ОТДЕЛЬНЫМ запросом, а не колонкой в основном: тот стоит на горячем пути
	// приёма ответа, и подсчёт участников там был бы платой за то, что нужно
	// одному редкому действию — приглашению.
	EntitlementsWithMembers(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) (Row, error)
	// BumpAIGenerations списывает одну генерацию формы в периоде. Отдельным
	// утверждением после удачи, а не внутри создания формы: вызов модели может не
	// состояться, и списывать за него нечего.
	BumpAIGenerations(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) error
}

var _ Store = Repo{}

// Decision — ответ на «можно ли».
//
// Структура, а не error: у двух потребителей разные потребности. Чтению
// (воронка) нужен отказ — оно превращает !Allowed в ErrPlanRequired. Приёму
// ответа отказывать НЕЛЬЗЯ ни при каком состоянии подписки — ему нужен сам
// факт «сверх квоты», чтобы пометить строку и пропустить ответ дальше
// (спека §6). Used/Limit нужны кабинету: прогресс-бар и «87 из 100».
type Decision struct {
	Allowed bool
	Used    int64
	// Limit — nil означает безлимит (и в plans.limits это null).
	Limit *int64
	// Period — расчётный период, ПО КОТОРОМУ принято это решение. Едет вместе с
	// решением, а не вычисляется вызывающим заново: приём ответа инкрементит
	// расход и обязан попасть в тот же период, что прочитала проверка. Два
	// независимых чтения часов расходятся на границе месяца — редко, но
	// беззвучно: счёт уезжает в закрытый месяц, а новый остаётся неполным.
	Period time.Time
}

// Snapshot — картина тарифа для кабинета: одна поездка, из которой рисуются
// и прогресс-бар, и замки, и плашки.
type Snapshot struct {
	PlanCode  string
	PlanTitle string
	// PeriodEnd — момент обнуления расхода (первое число следующего месяца, МСК).
	PeriodEnd time.Time
	Features  map[Key]Decision
}

// Service — единая точка проверки лимитов.
type Service struct {
	db   postgres.DBTX
	repo Store
	now  func() time.Time
}

func NewService(db postgres.DBTX, repo Store, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{db: db, repo: repo, now: now}
}

// CheckWorkspace отвечает, разрешена ли возможность плану воркспейса.
//
// Ошибка означает «спросить не удалось», а не «нельзя»: воркспейс без подписки
// (нарушенный инвариант регистрации) и план, молчащий про известный ключ, —
// это внутренние ошибки, и вызывающий обязан разобрать их сам. Приём ответа
// при такой ошибке НЕ помечает строку (щедро, но не теряет данные), чтение —
// отвечает 500, то есть ломается заметно.
func (s *Service) CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key Key) (Decision, error) {
	f, ok := Catalog[key]
	if !ok {
		return Decision{}, fmt.Errorf("entitlements: неизвестный ключ %q", key)
	}
	if f.Scope != WorkspaceScope {
		// Не «не разрешено», а ошибка вызывающего: аккаунт-уровневый ключ
		// воркспейсом невыразим, и молча ответить на него нельзя.
		return Decision{}, fmt.Errorf("entitlements: ключ %q — аккаунт-уровневый, CheckWorkspace его не обслуживает", key)
	}

	period := s.PeriodStart()
	// Запрос выбирается счётчиком возможности: горячий путь приёма ответа не
	// платит за подсчёт участников, который нужен только приглашению.
	fetch := s.repo.Entitlements
	switch f.Meter {
	case MembersMeter:
		fetch = s.repo.EntitlementsWithMembers
	case StorageMeter:
		fetch = s.repo.EntitlementsWithStorage
	}
	row, err := fetch(ctx, s.db, workspaceID, period)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Воркспейса без подписки не бывает: её создаёт транзакция
			// регистрации, существовавшие переведены миграцией 0014.
			return Decision{}, fmt.Errorf("entitlements: у воркспейса %s нет подписки: %w", workspaceID, err)
		}
		return Decision{}, err
	}
	d, err := decide(f, row, key)
	if err != nil {
		return Decision{}, err
	}
	d.Period = period
	return d, nil
}

// ConsumeAIGeneration списывает одну генерацию формы в ТОМ ЖЕ периоде, в котором
// её разрешила проверка. Период приходит параметром, а не читается часами заново:
// два независимых чтения часов расходятся на границе месяца, и списание уехало бы
// в месяц, которого проверка не видела, — тот же довод, что у Decision.Period.
//
// Гонка двух одновременных генераций на последнем месте квоты даёт перерасход в
// одну штуку: проверка и списание — не одна транзакция. Это осознанно и дёшево
// (мягкая квота у ответов ведёт себя так же); блокировка строки usage ради одного
// лишнего вызова в месяц стоила бы дороже самого вызова.
func (s *Service) ConsumeAIGeneration(ctx context.Context, workspaceID uuid.UUID, period time.Time) error {
	return s.repo.BumpAIGenerations(ctx, s.db, workspaceID, period)
}

// CheckAccount отвечает, разрешена ли возможность подписке самого аккаунта.
//
// Второй метод, а не параметр первого: аккаунт-уровневый лимит воркспейсом
// невыразим — нового пространства ещё нет, а старое к нему отношения не имеет
// (ADR §10). Сводить обратно к одной функции ради красоты нельзя: она приняла
// бы id воркспейса там, где его не существует.
func (s *Service) CheckAccount(ctx context.Context, userID uuid.UUID, key Key) (Decision, error) {
	f, ok := Catalog[key]
	if !ok {
		return Decision{}, fmt.Errorf("entitlements: неизвестный ключ %q", key)
	}
	if f.Scope != AccountScope {
		return Decision{}, fmt.Errorf("entitlements: ключ %q — воркспейс-уровневый, CheckAccount его не обслуживает", key)
	}

	row, err := s.repo.AccountEntitlements(ctx, s.db, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Аккаунта без подписки не бывает: её создаёт транзакция регистрации
			// (0014, субъект переехал на аккаунт в 0016).
			return Decision{}, fmt.Errorf("entitlements: у аккаунта %s нет подписки: %w", userID, err)
		}
		return Decision{}, err
	}
	// Период в решении не заполняется: у аккаунт-уровневого счётчика его нет —
	// место освобождается удалением пространства, а не первым числом месяца.
	return decide(f, row, key)
}

// Snapshot — состояние тарифа воркспейса для кабинета: план, лимиты, расход,
// дата обнуления. Одна поездка, из которой рисуются и прогресс-бар, и замки.
//
// Членство проверяет сам запрос (не член → 404): id воркспейса из URL правом
// доступа не является. Аккаунт-уровневые ключи в снимок не попадают — их
// разрешает план другого воркспейса, и показывать их здесь значило бы врать.
func (s *Service) Snapshot(ctx context.Context, userID, workspaceID uuid.UUID) (Snapshot, error) {
	period := s.PeriodStart()
	row, err := s.repo.EntitlementsForUser(ctx, s.db, workspaceID, userID, period)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Чужой или несуществующий воркспейс — неотличимы снаружи.
			return Snapshot{}, domain.ErrNotFound
		}
		return Snapshot{}, fmt.Errorf("entitlements: снимок воркспейса %s: %w", workspaceID, err)
	}

	snap := Snapshot{
		PlanCode:  row.PlanCode,
		PlanTitle: row.PlanTitle,
		PeriodEnd: period.AddDate(0, 1, 0),
		Features:  make(map[Key]Decision, len(Catalog)),
	}
	for key, f := range Catalog {
		if f.Scope != WorkspaceScope {
			continue
		}
		d, err := decide(f, row, key)
		if err != nil {
			return Snapshot{}, err
		}
		snap.Features[key] = d
	}
	return snap, nil
}

// PeriodStart — начало расчётного периода, в который попадает t: первое число
// его месяца по Москве. Календарный месяц, а не скользящие 30 дней (решение
// владельца): человек должен уметь предсказать, когда лимит обнулится.
//
// Экспортирована и чистая, потому что период нужен не только проверке: приём
// ответа инкрементит расход и обязан попасть в ТОТ ЖЕ период, что прочитала
// проверка. Две независимые реализации разъехались бы на границе месяца.
func PeriodStart(t time.Time) time.Time {
	t = t.In(moscow)
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, moscow)
}

// PeriodStart — текущий период сервиса (по его же часам).
func (s *Service) PeriodStart() time.Time { return PeriodStart(s.now()) }

// decide — чистая функция решения: план (как данные) + расход → вердикт.
// Вынесена из CheckWorkspace, чтобы её ветки проверялись табличными юнитами
// без БД.
func decide(f Feature, row Row, key Key) (Decision, error) {
	var limits map[string]json.RawMessage
	if err := json.Unmarshal(row.Limits, &limits); err != nil {
		return Decision{}, fmt.Errorf("entitlements: разбор limits плана %q: %w", row.PlanCode, err)
	}
	raw, ok := limits[string(key)]
	if !ok {
		// Молчание плана — ошибка конфигурации, а не «разрешено». Сторож,
		// который ловит её до прода, — TestPlansCoverCatalog.
		return Decision{}, fmt.Errorf("entitlements: план %q молчит про возможность %q", row.PlanCode, key)
	}

	used := int64(0)
	switch f.Meter {
	case SubmissionsMeter:
		used = row.SubmissionsUsed
	case WorkspacesMeter:
		used = row.WorkspacesOwned
	case MembersMeter:
		used = row.MembersCount
	case StorageMeter:
		used = row.StorageUsed
	case AIGenerationsMeter:
		used = row.AIGenerationsUsed
	case NoMeter:
		// Расход не считается: у Toggle его нет по смыслу.
	}

	switch f.Kind {
	case Toggle:
		var on bool
		if err := json.Unmarshal(raw, &on); err != nil {
			return Decision{}, fmt.Errorf("entitlements: возможность %q плана %q — не булев: %w", key, row.PlanCode, err)
		}
		return Decision{Allowed: on}, nil

	case Quota:
		// null = безлимит. Отличать его от «0» обязательно: ноль запрещает всё.
		if string(raw) == "null" {
			return Decision{Allowed: true, Used: used, Limit: nil}, nil
		}
		var limit int64
		if err := json.Unmarshal(raw, &limit); err != nil {
			return Decision{}, fmt.Errorf("entitlements: лимит %q плана %q — не число: %w", key, row.PlanCode, err)
		}
		if limit < 0 {
			return Decision{}, fmt.Errorf("entitlements: лимит %q плана %q отрицателен (%d)", key, row.PlanCode, limit)
		}
		return Decision{Allowed: used < limit, Used: used, Limit: &limit}, nil

	default:
		return Decision{}, fmt.Errorf("entitlements: у возможности %q неизвестный вид %d", key, f.Kind)
	}
}
