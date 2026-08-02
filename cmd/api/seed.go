package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/config"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// Демо-пользователь и объём сидирования. Учётка чисто dev-фикстура (пароль —
// известная константа в Makefile-подсказке, не секрет). 60 форм > одной страницы
// (DefaultPageLimit=50) — ровно чтобы проверять курсорную пагинацию глазами.
const (
	seedEmail    = "demo@trillix.local"
	seedPassword = "demo-password"
	seedFormsN   = 60

	// Выделенная форма для проверки CSV-экспорта: две опубликованные версии и много
	// ответов. Объём 10k — под DoD «экспорт 10 000 строк не растит память» (pprof).
	seedExportSubmissions = 10000
	seedExportV1Share     = 4000 // сколько из них отвечены по версии 1 (остальные — v2)
)

// seedOutbox — почтовый outbox для сидера: письма никуда не кладёт.
//
// Сидеру нужен НЕ nil, хотя писем он не шлёт: с фазы 12 сама `Register` кладёт в
// outbox письмо-подтверждение адреса (`enqueueVerificationEmail`), и nil-зависимость
// там разыменовывается — команда падала с SIGSEGV. Дефект был не виден, потому что
// на непустой БД `Register` возвращает ErrEmailTaken раньше этого места: ломался
// только сид по ЧИСТОЙ базе.
//
// Почему заглушка, а не настоящий mail.Service: письмо фикстуре не нужно и слать его
// некому (сидер живёт вне сервера, диспетчер outbox не крутится), а зависимость от
// почтовой конфигурации сделала бы `make seed` заложником MAIL_*. Токен подтверждения
// при этом создаётся честно — учётка ничем не отличается от заведённой через HTTP,
// кроме неотправленного письма.
type seedOutbox struct{}

func (seedOutbox) EnqueueEmail(context.Context, postgres.DBTX, mail.EmailMessage) error {
	return nil
}

// seedAuthService — auth-сервис для команд сидирования. Базовый URL кабинета пуст:
// ссылку в письме строить не для кого (см. seedOutbox).
func seedAuthService(pool *pgxpool.Pool) *auth.Service {
	return auth.NewService(
		pool, postgres.TxRunner{Pool: pool}, auth.Repo{}, seedOutbox{}, auth.DefaultSessionTTL, "",
	)
}

// runSeed наполняет БД демо-данными (пользователь + формы). Идемпотентен: если у
// демо-пользователя уже есть формы, ничего не добавляет (повторный запуск не
// плодит дубли).
func runSeed(cfg config.Config, log *slog.Logger) error {
	ctx := context.Background()
	pool, err := postgres.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	authSvc := seedAuthService(pool)
	formsSvc := forms.NewService(pool, postgres.TxRunner{Pool: pool}, forms.Repo{},
		workspaces.NewService(pool, postgres.TxRunner{Pool: pool}, workspaces.Repo{},
			entitlements.NewService(pool, entitlements.Repo{}, time.Now)))

	// Создать демо-пользователя или найти уже существующего.
	user, _, err := authSvc.Register(ctx, seedEmail, seedPassword)
	switch {
	case err == nil:
		log.Info("seed: demo user created", slog.String("email", seedEmail))
	case errors.Is(err, domain.ErrEmailTaken):
		if user, err = authSvc.UserByEmail(ctx, seedEmail); err != nil {
			return fmt.Errorf("lookup existing seed user: %w", err)
		}
		log.Info("seed: demo user already exists", slog.String("email", seedEmail))
	default:
		return fmt.Errorf("register seed user: %w", err)
	}

	// Идемпотентность: если формы уже есть — не досыпаем.
	page, err := formsSvc.List(ctx, user.ID, forms.ListOptions{Limit: forms.MaxPageLimit})
	if err != nil {
		return fmt.Errorf("check existing forms: %w", err)
	}
	if len(page.Forms) > 0 {
		log.Info("seed: forms already present, skipping",
			slog.Int("existing", len(page.Forms)))
		return nil
	}

	for i := 1; i <= seedFormsN; i++ {
		title := fmt.Sprintf("Демо-форма №%02d", i)
		if _, err := formsSvc.Create(ctx, user.ID, title, nil); err != nil {
			return fmt.Errorf("create seed form %d: %w", i, err)
		}
	}
	log.Info("seed: forms created", slog.Int("count", seedFormsN))

	if err := seedExportForm(ctx, pool, formsSvc, user.ID, log); err != nil {
		return fmt.Errorf("seed export form: %w", err)
	}
	return nil
}

// runSeedUser заводит ОДНУ учётку без форм: `api seed-user <email> <password>`.
// Идемпотентен — существующий адрес не ошибка (повторный прогон ничего не портит).
//
// Зачем отдельная команда, а не HTTP-регистрация: e2e-сценариям нужна сессия, а
// `POST /auth/register` сидит под своим ведром лимитера (registerBurst = 3 при
// пополнении ~1/30 с) — тремя существующими сценариями оно расходуется в ноль, и
// четвёртый падал бы на 429. Лимит ради тестов не ослабляется (инвариант 6), поэтому
// учётка заводится мимо HTTP — тем же сервисным вызовом, что и у `seed` (argon2id и
// все проверки на месте, обходится только транспорт). Команда требует доступа к БД,
// то есть новой поверхности атаки не создаёт: у кого есть DATABASE_URL, у того и так
// есть всё.
func runSeedUser(args []string, cfg config.Config, log *slog.Logger) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: api seed-user <email> <password>")
	}
	email, password := args[0], args[1]

	ctx := context.Background()
	pool, err := postgres.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	authSvc := seedAuthService(pool)

	// Пароль в лог не попадает ни в одной ветке (инвариант 2) — только адрес.
	switch _, _, err := authSvc.Register(ctx, email, password); {
	case err == nil:
		log.Info("seed-user: created", slog.String("email", email))
	case errors.Is(err, domain.ErrEmailTaken):
		log.Info("seed-user: already exists", slog.String("email", email))
	default:
		return fmt.Errorf("register user: %w", err)
	}
	return nil
}

// v1/v2 схемы демо-формы экспорта. v2 переименовывает опцию (o_fr), убирает вопрос
// b_phone и добавляет b_city — так CSV показывает объединение колонок (телефон живёт
// колонкой для ответов v1), подписи опций из версии ответа и пустые ячейки.
func exportSchemaV1() domain.FormSchema {
	return domain.FormSchema{SchemaVersion: domain.SchemaVersion, Blocks: []domain.Block{
		{ID: "t_name", GroupID: "g_name", Type: domain.BlockTitle, Text: domain.TextFromString("Ваше имя")},
		{ID: "b_name", GroupID: "g_name", Type: domain.BlockShortText, Required: true},
		{ID: "t_src", GroupID: "g_src", Type: domain.BlockTitle, Text: domain.TextFromString("Как вы о нас узнали?")},
		{ID: "b_src", GroupID: "g_src", Type: domain.BlockSingleChoice, Settings: domain.BlockSettings{
			Options: []domain.Option{{ID: "o_fr", Label: "Друзья"}, {ID: "o_se", Label: "Поиск"}, {ID: "o_ad", Label: "Реклама"}},
		}},
		{ID: "t_phone", GroupID: "g_phone", Type: domain.BlockTitle, Text: domain.TextFromString("Телефон")},
		{ID: "b_phone", GroupID: "g_phone", Type: domain.BlockShortText},
	}}
}

func exportSchemaV2() domain.FormSchema {
	return domain.FormSchema{SchemaVersion: domain.SchemaVersion, Blocks: []domain.Block{
		{ID: "t_name", GroupID: "g_name", Type: domain.BlockTitle, Text: domain.TextFromString("Ваше имя")},
		{ID: "b_name", GroupID: "g_name", Type: domain.BlockShortText, Required: true},
		{ID: "t_src", GroupID: "g_src", Type: domain.BlockTitle, Text: domain.TextFromString("Как вы о нас узнали?")},
		{ID: "b_src", GroupID: "g_src", Type: domain.BlockSingleChoice, Settings: domain.BlockSettings{
			Options: []domain.Option{{ID: "o_fr", Label: "Друзья (реф.)"}, {ID: "o_se", Label: "Поиск"}, {ID: "o_ad", Label: "Реклама"}},
		}},
		{ID: "t_city", GroupID: "g_city", Type: domain.BlockTitle, Text: domain.TextFromString("Город")},
		{ID: "b_city", GroupID: "g_city", Type: domain.BlockShortText},
	}}
}

// seedExportForm создаёт форму с двумя опубликованными версиями и наполняет её
// seedExportSubmissions ответами (часть по v1, часть по v2). Ответы вставляются
// напрямую в submissions одной транзакцией (быстро; путь приёма с антиспамом здесь
// не нужен). Опции выбираются случайно — CSV показывает разные подписи.
func seedExportForm(ctx context.Context, pool *pgxpool.Pool, formsSvc *forms.Service, userID uuid.UUID, log *slog.Logger) error {
	form, err := formsSvc.Create(ctx, userID, "CSV-демо (экспорт)", nil)
	if err != nil {
		return fmt.Errorf("create form: %w", err)
	}

	v1Schema, _ := json.Marshal(exportSchemaV1())
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, form.ID, v1Schema, form.UpdatedAt); err != nil {
		return fmt.Errorf("save v1 schema: %w", err)
	}
	pub1, err := formsSvc.Publish(ctx, userID, form.ID)
	if err != nil {
		return fmt.Errorf("publish v1: %w", err)
	}
	v1ID := *pub1.PublishedVersionID

	v2Schema, _ := json.Marshal(exportSchemaV2())
	// Publish двигает updated_at — берём его из результата публикации для след. сейва.
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, form.ID, v2Schema, pub1.UpdatedAt); err != nil {
		return fmt.Errorf("save v2 schema: %w", err)
	}
	pub2, err := formsSvc.Publish(ctx, userID, form.ID)
	if err != nil {
		return fmt.Errorf("publish v2: %w", err)
	}
	v2ID := *pub2.PublishedVersionID

	repo := submissions.Repo{}
	meta := json.RawMessage(`{}`)
	err = (postgres.TxRunner{Pool: pool}).WithTx(ctx, func(tx pgx.Tx) error {
		for i := 0; i < seedExportSubmissions; i++ {
			versionID, answers := v2ID, exportAnswersV2()
			if i < seedExportV1Share {
				versionID, answers = v1ID, exportAnswersV1()
			}
			if _, e := repo.InsertSubmission(ctx, tx, submissions.NewSubmission{
				ID:          domain.NewID(),
				FormID:      form.ID,
				VersionID:   versionID,
				Answers:     answers,
				Meta:        meta,
				WorkspaceID: form.WorkspaceID,
				Period:      entitlements.PeriodStart(time.Now()),
			}); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("insert submissions: %w", err)
	}

	log.Info("seed: export demo form created",
		slog.String("form_id", form.ID.String()),
		slog.String("slug", form.Slug),
		slog.Int("submissions", seedExportSubmissions))
	return nil
}

var exportSources = []string{"o_fr", "o_se", "o_ad"}

func exportAnswersV1() json.RawMessage {
	m := map[string]any{
		"b_name":  fmt.Sprintf("Респондент %d", rand.Intn(100000)),
		"b_src":   exportSources[rand.Intn(len(exportSources))],
		"b_phone": fmt.Sprintf("+7900%07d", rand.Intn(10000000)),
	}
	raw, _ := json.Marshal(m)
	return raw
}

func exportAnswersV2() json.RawMessage {
	m := map[string]any{
		"b_name": fmt.Sprintf("Респондент %d", rand.Intn(100000)),
		"b_src":  exportSources[rand.Intn(len(exportSources))],
		"b_city": fmt.Sprintf("Город %d", rand.Intn(500)),
	}
	raw, _ := json.Marshal(m)
	return raw
}
