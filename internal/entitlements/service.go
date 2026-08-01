package entitlements

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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
}

// Store — доступ к данным, объявленный на стороне потребителя. Реализация — Repo.
type Store interface {
	Entitlements(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) (Row, error)
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

	row, err := s.repo.Entitlements(ctx, s.db, workspaceID, s.periodStart())
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Воркспейса без подписки не бывает: её создаёт транзакция
			// регистрации, существовавшие переведены миграцией 0014.
			return Decision{}, fmt.Errorf("entitlements: у воркспейса %s нет подписки: %w", workspaceID, err)
		}
		return Decision{}, err
	}
	return decide(f, row, key)
}

// Snapshot — состояние тарифа целиком (страница «Тариф», плашки кабинета).
// Аккаунт-уровневые ключи в снимок не попадают: их разрешает план другого
// воркспейса, и показывать их здесь значило бы врать.
func (s *Service) Snapshot(ctx context.Context, workspaceID uuid.UUID) (Snapshot, error) {
	period := s.periodStart()
	row, err := s.repo.Entitlements(ctx, s.db, workspaceID, period)
	if err != nil {
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

// periodStart — первое число текущего месяца по Москве. Календарный месяц, а не
// скользящие 30 дней (решение владельца): человек должен уметь предсказать,
// когда лимит обнулится.
func (s *Service) periodStart() time.Time {
	t := s.now().In(moscow)
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, moscow)
}

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
	if f.Meter == SubmissionsMeter {
		used = row.SubmissionsUsed
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
