package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"slices"
	"strconv"
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
		workspaces.NewService(pool, postgres.TxRunner{Pool: pool}, workspaces.Repo{}, plansSvc, ""),
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

	var formID, versionID, workspaceID uuid.UUID
	var slug string
	query := `SELECT id, slug, published_version_id, workspace_id FROM forms
	          WHERE published_version_id IS NOT NULL AND title LIKE 'CSV-демо%'
	          ORDER BY created_at LIMIT 1`
	arg := []any{}
	if len(args) > 0 && args[0] != "" {
		query = `SELECT id, slug, published_version_id, workspace_id FROM forms
		         WHERE slug = $1 AND published_version_id IS NOT NULL`
		arg = []any{args[0]}
	}
	if err := pool.QueryRow(ctx, query, arg...).Scan(&formID, &slug, &versionID, &workspaceID); err != nil {
		return fmt.Errorf("find published form (сначала `make seed` или укажите slug): %w", err)
	}

	if err := seedVisits(ctx, pool, formID, versionID, log); err != nil {
		return fmt.Errorf("seed visits: %w", err)
	}
	if err := seedAnswers(ctx, pool, formID, versionID, workspaceID, log); err != nil {
		return fmt.Errorf("seed answers: %w", err)
	}
	log.Info("seed-visits: готово", slog.String("slug", slug))
	return nil
}

// seedAnswersCount — сколько ответов досыпать, и seedAnswersSkipAbove — с какого
// числа уже собранных ответов команда их не трогает. Порог нужен ровно затем,
// чтобы демо-форма экспорта (10 000 ответов по двум версиям) не получала поверх
// своих данных горсть чужих: там сводка и так есть, а тут — цель команды.
const (
	seedAnswersCount     = 60
	seedAnswersSkipAbove = 200
)

// seedAnswers досыпает ответы: без них вкладка «Сводка» пуста, и оценить её вид
// не по чему — а визиты её не наполняют, это второй, независимый источник данных
// (docs/ANALYTICS.md §1).
func seedAnswers(ctx context.Context, pool *pgxpool.Pool, formID, versionID, workspaceID uuid.UUID, log *slog.Logger) error {
	var existing int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM submissions WHERE form_id = $1`, formID).Scan(&existing); err != nil {
		return fmt.Errorf("count submissions: %w", err)
	}
	if existing > seedAnswersSkipAbove {
		log.Info("seed: answers skipped, form already has data", slog.Int("submissions", existing))
		return nil
	}
	questions, err := seedQuestions(ctx, pool, versionID)
	if err != nil {
		return err
	}
	if len(questions) == 0 {
		log.Info("seed: answers skipped, form has no questions")
		return nil
	}

	// Времена ответов раскидываются по двум неделям и сортируются ПО ВОЗРАСТАНИЮ,
	// после чего строки вставляются в этом порядке. Это не косметика: id ответа —
	// UUIDv7, и весь кабинет сортирует ответы по нему, а не по created_at (см.
	// ListSubmissionsFirstPage). Вставь их вразнобой — и демо-данные окажутся
	// единственным местом, где id и дата разошлись: экран честно покажет «новые
	// сверху» по id, а даты в нём будут прыгать.
	times := make([]time.Time, seedAnswersCount)
	for i := range times {
		times[i] = time.Now().Add(-time.Duration(rand.Intn(14*24*60)) * time.Minute)
	}
	slices.SortFunc(times, func(a, b time.Time) int { return a.Compare(b) })

	repo := submissions.Repo{}
	meta := json.RawMessage(`{}`)
	created := 0
	err = (postgres.TxRunner{Pool: pool}).WithTx(ctx, func(tx pgx.Tx) error {
		for i := 0; i < seedAnswersCount; i++ {
			answers := make(map[string]any, len(questions))
			for _, q := range questions {
				// Необязательный вопрос заполняют не все. Иначе у каждой строки
				// сводки один и тот же знаменатель, и «Ответили 60 из 60» не
				// сообщает ничего — а именно разница знаменателей и есть то, ради
				// чего на сводку смотрят.
				if !q.Block.Required && rand.Intn(10) < 4 {
					continue
				}
				if v, ok := seedAnswerValue(q.Block); ok {
					answers[q.ID] = v
				}
			}
			raw, _ := json.Marshal(answers)
			id := domain.NewID()
			at := times[i]
			if _, e := repo.InsertSubmission(ctx, tx, submissions.NewSubmission{
				ID:          id,
				FormID:      formID,
				VersionID:   versionID,
				Answers:     raw,
				Meta:        meta,
				WorkspaceID: workspaceID,
				Period:      entitlements.PeriodStart(at),
			}); e != nil {
				return e
			}
			// Время ответа проставляется вторым запросом: в параметрах приёма его
			// нет и быть не должно — в бою это всегда now(). Без разброса все
			// демо-ответы лягут одной секундой, и окно наблюдения (сутки, неделя,
			// месяц) станет неотличимым от «всего времени».
			if _, e := tx.Exec(ctx, `UPDATE submissions SET created_at = $2 WHERE id = $1`, id, at); e != nil {
				return e
			}
			created++
		}
		return nil
	})
	if err != nil {
		return err
	}
	log.Info("seed: demo answers created", slog.Int("answers", created), slog.Int("questions", len(questions)))
	return nil
}

// seedAnswerValue — правдоподобный ответ ПО ТИПУ блока. Тип обязателен: выдуманная
// строка в вопросе с вариантами попала бы в сводку неизвестной опцией, а число вне
// диапазона шкалы — делением, которого у шкалы нет. Второй результат — «отвечать
// нечем» (файл, пустой список вариантов): такой вопрос просто не заполняется.
//
// Все значения — СТРОКИ, включая шкалу и число: таков формат ответа
// (domain.validateScaleAnswer, validateTextAnswer), и число здесь развалило бы
// приём.
func seedAnswerValue(b domain.Block) (any, bool) {
	switch b.Type {
	case domain.BlockSingleChoice, domain.BlockDropdown:
		if len(b.Settings.Options) == 0 {
			return nil, false
		}
		return b.Settings.Options[rand.Intn(len(b.Settings.Options))].ID, true
	case domain.BlockMultiChoice:
		if len(b.Settings.Options) == 0 {
			return nil, false
		}
		var picked []string
		for _, o := range b.Settings.Options {
			if rand.Intn(3) == 0 {
				picked = append(picked, o.ID)
			}
		}
		if len(picked) == 0 {
			picked = []string{b.Settings.Options[rand.Intn(len(b.Settings.Options))].ID}
		}
		return picked, true
	case domain.BlockScale:
		min, max := 1, 5
		if b.Settings.ScaleMin != nil {
			min = *b.Settings.ScaleMin
		}
		if b.Settings.ScaleMax != nil {
			max = *b.Settings.ScaleMax
		}
		if max < min {
			return nil, false
		}
		// Оценки смещены вверх: равномерная шкала на экране выглядит генератором
		// случайных чисел, каким она и была бы.
		v := min + rand.Intn(max-min+1)
		if w := min + rand.Intn(max-min+1); w > v {
			v = w
		}
		return strconv.Itoa(v), true
	case domain.BlockRating:
		n := domain.DefaultRatingStars
		if b.Settings.RatingStars != 0 {
			n = b.Settings.RatingStars
		}
		// Смещение вверх — как у шкалы.
		v := 1 + rand.Intn(n)
		if w := 1 + rand.Intn(n); w > v {
			v = w
		}
		return strconv.Itoa(v), true
	case domain.BlockNumber:
		return strconv.Itoa(1 + rand.Intn(60)), true
	case domain.BlockConsent:
		// Снявший галочку и не тронувший вопрос — для сводки одно и то же «нет»,
		// поэтому несогласие это просто отсутствие ответа.
		if rand.Intn(10) < 8 {
			return domain.ConsentYes, true
		}
		return nil, false
	case domain.BlockEmail:
		return fmt.Sprintf("%s%d@example.com", seedLogins[rand.Intn(len(seedLogins))], rand.Intn(900)), true
	case domain.BlockPhone:
		return fmt.Sprintf("+7 900 %03d-%02d-%02d", rand.Intn(1000), rand.Intn(100), rand.Intn(100)), true
	case domain.BlockDate:
		return time.Now().AddDate(0, 0, -rand.Intn(400)).Format("2006-01-02"), true
	case domain.BlockFile:
		// Файл живёт отдельной загрузкой с выданным сервером id — придумать его
		// нельзя, а выдуманный не сойдётся с таблицей загрузок.
		return nil, false
	case domain.BlockLongText:
		return seedLongTexts[rand.Intn(len(seedLongTexts))], true
	default:
		return seedShortTexts[rand.Intn(len(seedShortTexts))], true
	}
}

// Тексты подобраны РАЗНОЙ длины: на сводке они стоят списком последних ответов, и
// строки одного размера не показали бы, как список ведёт себя с длинным ответом.
var (
	seedLogins     = []string{"anna", "petr", "maria", "oleg", "kira", "sergey", "dasha"}
	seedShortTexts = []string{
		"Анна", "Пётр", "Мария Кузнецова", "Олег", "Кира", "Сергей Иванов", "Дарья",
		"да", "Нет, спасибо", "112233", "Санкт-Петербург", "не знаю",
		"Хочу узнать подробнее о тарифах",
	}
	seedLongTexts = []string{
		"Москва, Ленинградский проспект, 15, кв. 42",
		"Всё понравилось, спасибо!",
		"Нашёл вас через поиск, оформил заявку с телефона — форма открылась быстро, вопросов не возникло.",
		"Хотелось бы больше вариантов оплаты и возможность сохранить черновик, чтобы вернуться позже. В остальном удобно.",
		"—",
	}
)

// seedVisits наполняет аналитику формы: ряд по времени, источники, устройства,
// браузеры, системы, страны, города и воронку по НАСТОЯЩИМ вопросам формы.
//
// Зачем это в seed. На локальном контуре аналитику увидеть НЕ ИЗ ЧЕГО: визиты
// приходят с 127.0.0.1, а у локального адреса страны нет и быть не может (см.
// geo.Lookup), поэтому экран «Визиты» на dev-машине пустой, даже когда всё
// работает. Отличить это от ненаписанной функции глазами нельзя.
//
// Пишем напрямую в таблицу, а не биконами через HTTP: бикон честно принесёт
// локальный адрес, и весь смысл потеряется.
func seedVisits(ctx context.Context, pool *pgxpool.Pool, formID, versionID uuid.UUID, log *slog.Logger) error {
	questions, err := seedQuestions(ctx, pool, versionID)
	if err != nil {
		return err
	}

	const days = 14
	inserted := 0
	err = (postgres.TxRunner{Pool: pool}).WithTx(ctx, func(tx pgx.Tx) error {
		for day := 0; day < days; day++ {
			// Число визитов в день гуляет: ровный ряд выглядел бы как заглушка.
			perDay := 8 + rand.Intn(22)
			for i := 0; i < perDay; i++ {
				agent := pickWeighted(seedAgents, func(a seedAgent) int { return a.w })
				place := pickWeighted(seedPlaces, func(p seedPlace) int { return p.w })
				src := pickWeighted(seedSources, func(s seedSource) int { return s.w })

				// Доля дошедших падает на каждом вопросе. Ровная воронка не дала бы
				// увидеть, работает ли экран: у неё все ступени одной длины.
				// Ноль пройденных вопросов — это «ушёл, не тронув ни одного», своя
				// строка воронки, и она обязана встречаться.
				reach := 0
				for reach < len(questions) && rand.Float64() < seedReachRate {
					reach++
				}
				var lastBlock *string
				if reach > 0 {
					lastBlock = &questions[reach-1].ID
				}
				// Отправить, не дойдя до последнего вопроса, нельзя: сервер ставит
				// эту отметку на приёме ответа. Данные, в которых конверсия выше
				// верха воронки, показали бы экран в состоянии, невозможном в бою.
				submitted := len(questions) > 0 && reach == len(questions) && rand.Intn(4) > 0

				at := time.Now().AddDate(0, 0, -day).Add(-time.Duration(rand.Intn(24)) * time.Hour)
				meta := map[string]string{"user_agent": agent.ua, "referer": src.referer}
				if src.utmSource != "" {
					meta["utm_source"] = src.utmSource
					meta["utm_medium"] = src.utmMedium
				}
				metaJSON, _ := json.Marshal(meta)
				// Ключ посетителя: один и тот же на пару «человек + сутки», как в
				// бою. Без него карточка «Уникальные» показывала бы ноль при сотнях
				// визитов — та же ловушка, что была с гео.
				keySrc := sha256.Sum256(fmt.Appendf(nil, "seed:%d:%d", day, rand.Intn(12)))
				visitorKey := keySrc[:16]
				// Дошедший до конца провёл на форме больше: иначе карточки
				// «длительность визита» и «длительность заполнения» показывали бы
				// одно и то же число и выглядели опечаткой.
				seconds := 20 + rand.Intn(160)
				if submitted {
					seconds = 90 + rand.Intn(300)
				}
				_, e := tx.Exec(ctx, `
					INSERT INTO form_visits (id, form_id, form_version_id, last_block_id, seq,
					                         submitted, meta, country_code, country, city,
					                         visitor_key, created_at, updated_at)
					VALUES ($1, $2, $3, $12, 1, $4, $5,
					        nullif($6, ''), nullif($7, ''), nullif($8, ''), $9,
					        $10::timestamptz, $10::timestamptz + $11::interval)`,
					domain.NewID(), formID, versionID, submitted, metaJSON,
					place.code, place.country, place.city, visitorKey, at,
					fmt.Sprintf("%d seconds", seconds), lastBlock)
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
	log.Info("seed: demo visits created",
		slog.Int("visits", inserted), slog.Int("days", days), slog.Int("questions", len(questions)))
	return nil
}

// seedReachRate — вероятность пройти следующий вопрос. 0.86 на семи вопросах даёт
// около трети дошедших до конца: воронка заметно сужается, но не вырождается.
const seedReachRate = 0.86

// seedQuestions — вопросы формы той же моделью, что и сама воронка
// (domain.QuestionOrder). Свой обход блоков здесь заводить нельзя: демо-данные,
// разложенные по другому списку вопросов, показали бы экран, которого не бывает.
func seedQuestions(ctx context.Context, pool *pgxpool.Pool, versionID uuid.UUID) ([]domain.Question, error) {
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT schema FROM form_versions WHERE id = $1`, versionID).Scan(&raw); err != nil {
		return nil, fmt.Errorf("read version schema: %w", err)
	}
	var schema domain.FormSchema
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil, fmt.Errorf("parse version schema: %w", err)
	}
	return domain.QuestionOrder([]domain.VersionedSchema{{Version: 1, Schema: schema}}), nil
}

// pickWeighted — случайная строка таблицы с учётом веса. Без весов все строки
// разбивки выходят одной длины, и экран «Визиты» выглядит заглушкой, а не данными:
// ровно по длинному хвосту и видно, что список отсортирован и что-то считает.
func pickWeighted[T any](items []T, weight func(T) int) T {
	total := 0
	for _, it := range items {
		total += weight(it)
	}
	n := rand.Intn(total)
	for _, it := range items {
		n -= weight(it)
		if n < 0 {
			return it
		}
	}
	return items[len(items)-1]
}

// seedAgent — user-agent демо-визита. ОДНА строка на визит, и это принципиально:
// браузер, систему и вид устройства сервер выводит из неё же
// (domain.ParseUserAgent). Перечислять их отдельными полями значило бы разрешить
// трём разбивкам экрана разъехаться между собой.
type seedAgent struct {
	ua string
	w  int
}

var seedAgents = []seedAgent{
	{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", 26},
	{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", 22},
	{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 YaBrowser/25.8.0.0 Safari/537.36", 14},
	{"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", 12},
	{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", 10},
	{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0", 8},
	{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 7},
	{"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0", 6},
	{"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", 6},
	{"Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1", 4},
	{"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", 3},
	{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/124.0.0.0", 3},
	// Робот попадает в разбивку наравне с людьми и должен быть на экране виден:
	// строка «Робот» в браузерах — не мусор, а повод не считать его человеком.
	{"Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", 3},
}

// seedPlace — страна и город визита. Города разных стран намеренно перемешаны:
// список городов на экране отдельный от списка стран, и одноимённые города в
// разных странах — обычное дело.
type seedPlace struct {
	code, country, city string
	w                   int
}

var seedPlaces = []seedPlace{
	{"RU", "Россия", "Москва", 30},
	{"RU", "Россия", "Санкт-Петербург", 16},
	{"RU", "Россия", "Екатеринбург", 7},
	{"RU", "Россия", "Новосибирск", 6},
	{"RU", "Россия", "Казань", 5},
	{"RU", "Россия", "Краснодар", 4},
	{"BY", "Беларусь", "Минск", 8},
	{"BY", "Беларусь", "Гомель", 2},
	{"KZ", "Казахстан", "Алматы", 6},
	{"KZ", "Казахстан", "Астана", 3},
	{"AM", "Армения", "Ереван", 3},
	{"GE", "Грузия", "Тбилиси", 2},
	{"DE", "Германия", "Берлин", 2},
	{"RS", "Сербия", "Белград", 1},
	// Без места — так выглядит визит по IPv6 или из приватной сети. Он рисует на
	// экране «ещё N визитов без страны», то есть честную границу метрики.
	{"", "", "", 5},
}

// seedSource — откуда пришёл визит: размеченная ссылка (utm) ИЛИ переход с чужого
// сайта (referer) ИЛИ прямой заход (пусто). Три состояния, а не два поля рядом:
// размеченная ссылка перебивает реферер, и заполнять оба значило бы готовить
// данные, которых бикон не приносит.
type seedSource struct {
	referer, utmSource, utmMedium string
	w                             int
}

var seedSources = []seedSource{
	{"", "", "", 30},
	{"", "newsletter", "email", 12},
	{"", "telegram", "social", 10},
	{"", "yandex-direct", "cpc", 7},
	{"", "vk-ads", "cpc", 5},
	{"https://t.me/channel", "", "", 9},
	{"https://yandex.ru/search/", "", "", 8},
	{"https://vk.com/wall-1", "", "", 7},
	{"https://www.google.com/", "", "", 6},
	{"https://habr.com/ru/articles/1", "", "", 4},
	{"https://mail.ru/", "", "", 2},
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
