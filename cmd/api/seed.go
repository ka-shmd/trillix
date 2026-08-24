package main

import (
	"context"
	"crypto/sha256"
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
	plansSvc := entitlements.NewService(pool, entitlements.Repo{}, time.Now)
	formsSvc := forms.NewService(pool, postgres.TxRunner{Pool: pool}, forms.Repo{},
		workspaces.NewService(pool, postgres.TxRunner{Pool: pool}, workspaces.Repo{}, plansSvc, nil, ""),
		plansSvc)

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

// caption — текст ПОДПИСИ вопроса: жирный маркой `b`, а не весом поверхности
// (миграция 0025). Через TextFromString подписи демо-формы вышли бы обычным текстом —
// то есть не так, как выглядит форма, собранная руками в редакторе.
func caption(s string) []domain.Span {
	return []domain.Span{{T: s, M: []domain.Mark{domain.MarkBold}}}
}

// v1/v2 схемы демо-формы экспорта. v2 переименовывает опцию (o_fr), убирает вопрос
// b_phone и добавляет b_city — так CSV показывает объединение колонок (телефон живёт
// колонкой для ответов v1), подписи опций из версии ответа и пустые ячейки.
func exportSchemaV1() domain.FormSchema {
	return domain.FormSchema{SchemaVersion: domain.SchemaVersion, Blocks: []domain.Block{
		{ID: "t_name", GroupID: "g_name", Type: domain.BlockTitle, Text: caption("Ваше имя")},
		{ID: "b_name", GroupID: "g_name", Type: domain.BlockShortText, Required: true},
		{ID: "t_src", GroupID: "g_src", Type: domain.BlockTitle, Text: caption("Как вы о нас узнали?")},
		{ID: "b_src", GroupID: "g_src", Type: domain.BlockSingleChoice, Settings: domain.BlockSettings{
			Options: []domain.Option{{ID: "o_fr", Label: "Друзья"}, {ID: "o_se", Label: "Поиск"}, {ID: "o_ad", Label: "Реклама"}},
		}},
		{ID: "t_phone", GroupID: "g_phone", Type: domain.BlockTitle, Text: caption("Телефон")},
		{ID: "b_phone", GroupID: "g_phone", Type: domain.BlockShortText},
	}}
}

func exportSchemaV2() domain.FormSchema {
	return domain.FormSchema{SchemaVersion: domain.SchemaVersion, Blocks: []domain.Block{
		{ID: "t_name", GroupID: "g_name", Type: domain.BlockTitle, Text: caption("Ваше имя")},
		{ID: "b_name", GroupID: "g_name", Type: domain.BlockShortText, Required: true},
		{ID: "t_src", GroupID: "g_src", Type: domain.BlockTitle, Text: caption("Как вы о нас узнали?")},
		{ID: "b_src", GroupID: "g_src", Type: domain.BlockSingleChoice, Settings: domain.BlockSettings{
			Options: []domain.Option{{ID: "o_fr", Label: "Друзья (реф.)"}, {ID: "o_se", Label: "Поиск"}, {ID: "o_ad", Label: "Реклама"}},
		}},
		{ID: "t_city", GroupID: "g_city", Type: domain.BlockTitle, Text: caption("Город")},
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

	if err := seedVisits(ctx, pool, form.ID, v2ID, log); err != nil {
		return fmt.Errorf("seed visits: %w", err)
	}

	log.Info("seed: export demo form created",
		slog.String("form_id", form.ID.String()),
		slog.String("slug", form.Slug),
		slog.Int("submissions", seedExportSubmissions))
	return nil
}

// runSeedVisits досыпает визиты В СУЩЕСТВУЮЩУЮ форму: `api seed-visits [slug]`.
//
// Отдельная команда, а не часть `seed`, по одной причине: `seed` идемпотентен и на
// непустой базе не делает ничего — а именно такая база у всех, кто работает с
// проектом не первый день. Без этой команды посмотреть аналитику им пришлось бы
// уронив свою базу.
//
// Без аргумента берётся демо-форма экспорта; со slug'ом — любая опубликованная.
func runSeedVisits(args []string, cfg config.Config, log *slog.Logger) error {
	ctx := context.Background()
	pool, err := postgres.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	var formID, versionID uuid.UUID
	var slug string
	query := `SELECT id, slug, published_version_id FROM forms
	          WHERE published_version_id IS NOT NULL AND title LIKE 'CSV-демо%'
	          ORDER BY created_at LIMIT 1`
	arg := []any{}
	if len(args) > 0 && args[0] != "" {
		query = `SELECT id, slug, published_version_id FROM forms
		         WHERE slug = $1 AND published_version_id IS NOT NULL`
		arg = []any{args[0]}
	}
	if err := pool.QueryRow(ctx, query, arg...).Scan(&formID, &slug, &versionID); err != nil {
		return fmt.Errorf("find published form (сначала `make seed` или укажите slug): %w", err)
	}

	if err := seedVisits(ctx, pool, formID, versionID, log); err != nil {
		return fmt.Errorf("seed visits: %w", err)
	}
	log.Info("seed-visits: готово", slog.String("slug", slug))
	return nil
}

// seedVisits наполняет аналитику демо-формы: ряд по времени, источники,
// устройства, страны и города.
//
// Зачем это в seed. На локальном контуре аналитику увидеть НЕ ИЗ ЧЕГО: визиты
// приходят с 127.0.0.1, а у локального адреса страны нет и быть не может (см.
// geo.Lookup), поэтому экран «Визиты» на dev-машине пустой, даже когда всё
// работает. Отличить это от ненаписанной функции глазами нельзя — и именно так
// оно и выглядело владельцу.
//
// Пишем напрямую в таблицу, а не биконами через HTTP: бикон честно принесёт
// локальный адрес, и весь смысл потеряется.
func seedVisits(ctx context.Context, pool *pgxpool.Pool, formID, versionID uuid.UUID, log *slog.Logger) error {
	// Места и агенты подобраны так, чтобы на экране было видно РАЗНОЕ: две страны
	// с несколькими городами, компьютер и телефон, размеченная ссылка и переход с
	// чужого сайта. Последняя строка без места — она рисует «ещё N визитов без
	// страны», то есть честную границу метрики.
	type sample struct {
		countryCode, country, city, userAgent, referer, utmSource string
	}
	chrome := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
	safariPhone := "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
	samples := []sample{
		{"RU", "Россия", "Москва", chrome, "", "newsletter"},
		{"RU", "Россия", "Москва", safariPhone, "https://vk.com/wall-1", ""},
		{"RU", "Россия", "Санкт-Петербург", chrome, "", ""},
		{"RU", "Россия", "Новосибирск", safariPhone, "https://t.me/channel", ""},
		{"BY", "Беларусь", "Минск", chrome, "", "newsletter"},
		{"KZ", "Казахстан", "Алматы", safariPhone, "", ""},
		{"", "", "", chrome, "", ""}, // место не определено — так выглядит IPv6
	}

	const days = 14
	inserted := 0
	err := (postgres.TxRunner{Pool: pool}).WithTx(ctx, func(tx pgx.Tx) error {
		for day := 0; day < days; day++ {
			// Число визитов в день гуляет: ровный ряд выглядел бы как заглушка.
			perDay := 6 + rand.Intn(12)
			for i := 0; i < perDay; i++ {
				sm := samples[rand.Intn(len(samples))]
				at := time.Now().AddDate(0, 0, -day).Add(-time.Duration(rand.Intn(24)) * time.Hour)
				meta := map[string]string{"user_agent": sm.userAgent, "referer": sm.referer}
				if sm.utmSource != "" {
					meta["utm_source"] = sm.utmSource
					meta["utm_medium"] = "email"
				}
				metaJSON, _ := json.Marshal(meta)
				// Ключ посетителя: один и тот же на пару «человек + сутки», как в
				// бою. Без него карточка «Уникальные» показывала бы ноль при сотнях
				// визитов — та же ловушка, что была с гео.
				keySrc := sha256.Sum256([]byte(fmt.Sprintf("seed:%d:%d", day, rand.Intn(len(samples)))))
				visitorKey := keySrc[:16]
				_, e := tx.Exec(ctx, `
					INSERT INTO form_visits (id, form_id, form_version_id, last_block_id, seq,
					                         submitted, meta, country_code, country, city,
					                         visitor_key, created_at, updated_at)
					VALUES ($1, $2, $3, 'b_name', 1, $4, $5,
					        nullif($6, ''), nullif($7, ''), nullif($8, ''), $9,
					        $10::timestamptz, $10::timestamptz + $11::interval)`,
					domain.NewID(), formID, versionID, rand.Intn(3) == 0, metaJSON,
					sm.countryCode, sm.country, sm.city, visitorKey, at,
					fmt.Sprintf("%d seconds", 15+rand.Intn(180)))
				if e != nil {
					return e
				}
				inserted++
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	log.Info("seed: demo visits created", slog.Int("visits", inserted), slog.Int("days", days))
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
