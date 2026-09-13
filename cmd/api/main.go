// Command api — composition root. Без аргументов запускает HTTP-сервер;
// подкоманда `migrate up|down` прогоняет миграции тем же бинарником.
package main

import (
	"context"
	"fmt"
	"log/slog"
	netmail "net/mail"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	// База часовых поясов ВНУТРЬ БИНАРНИКА (фаза 27, ADR §10).
	//
	// ⚠ МИНА: продуктовый образ — gcr.io/distroless/static (deploy/Dockerfile), в
	// нём нет ни /usr/share/zoneinfo, ни пакета tzdata, и без этой строки
	// time.LoadLocation("Europe/Moscow") падает ТОЛЬКО НА ПРОДЕ: на машине
	// разработчика и в CI зоны читаются из системы. Расписания записи хранят пояс
	// автора (schedules.timezone) и обязаны знать переходы на летнее время, поэтому
	// обход через time.FixedZone, сделанный в internal/entitlements, здесь не годится.
	// Цена — около 450 КиБ размера бинарника.
	_ "time/tzdata"

	"github.com/ka-shmd/trillix/internal/ai"
	"github.com/ka-shmd/trillix/internal/answerfiles"
	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/booking"
	"github.com/ka-shmd/trillix/internal/config"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/geo"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/media"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/oauth"
	"github.com/ka-shmd/trillix/internal/periodic"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/printer"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/safehttp"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/templates"
	"github.com/ka-shmd/trillix/internal/visits"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// Жёсткий лимит на POST /auth/login по IP: запас 5 попыток, пополнение ~1 в 12 с.
const (
	loginRatePerSec = 1.0 / 12.0
	loginBurst      = 5

	// Жёсткий лимит на POST /auth/register по IP (отдельное ведро, жёстче логина):
	// argon2id — 64 МиБ памяти на вызов, а регистрация — редкое разовое действие.
	// Запас 3, пополнение ~1 в 30 с — терпимо к паре ретраев, режет ресурсный флуд.
	registerRatePerSec = 1.0 / 30.0
	registerBurst      = 3

	// Жёсткий лимит на POST приёма ответа по IP (отдельный от логина): запас 20,
	// пополнение ~1 в 3 с (устойчиво ~20/мин). Терпимо к киоску, где несколько
	// человек отвечают с одного IP, но режет автоматический перебор.
	submitRatePerSec = 1.0 / 3.0
	submitBurst      = 20

	// Потолок писем РЕСПОНДЕНТАМ на одну форму: запас 100, пополнение ~1 в 36 с
	// (устойчиво 100/час). Ключ ведра — id формы, а не IP: адресатов много и они
	// разные, ограничивается форма как источник рассылки
	// (docs/design/respondent-email.md §5).
	//
	// Стоит потому, что квота отправки у провайдера ОБЩАЯ на весь сервис: одна
	// виральная форма способна выесть её целиком, и тогда молчат и сбросы пароля.
	// Ведро в памяти — та же реализация, что у прочих лимитов продукта, и та же
	// цена: перезапуск процесса обнуляет окно.
	respondentMailRatePerSec = 100.0 / 3600.0
	respondentMailBurst      = 100

	// Лимит на выдачу токена времени по IP (своё ведро, ARCHITECTURE §4.6). Токен
	// сам по себе бесполезен — им можно только отправить ответ, а тот ограничен
	// своим ведром, — поэтому пополнение взято такое же, как у приёма ответа: это
	// держит заготовку токенов пачкой в том же порядке, что и сами отправки. Запас
	// шире (30 против 20): открыть форму дешевле, чем ответить, и перезагрузка
	// страницы — обычное поведение, а не признак перебора.
	formTokenRatePerSec = 1.0 / 3.0
	formTokenBurst      = 30

	// Лимит попыток пароля формы — ведро по паре «IP + slug» (0047). Ключ парный
	// намеренно: по одному адресу подбор одной формы закрывал бы человеку все
	// остальные, по одному slug один подбирающий закрывал бы форму всем участникам.
	//
	// Шесть попыток и одна новая в 30 секунд: человек, которому пароль прислали,
	// ошибётся раз-другой и попадёт, а перебор словаря упирается в стену на седьмой
	// строке. Ведро списывается ДО сравнения (public_handler.unlock), поэтому верный
	// пароль исчерпанный лимит не обходит.
	unlockRatePerSec = 1.0 / 30.0
	unlockBurst      = 6

	// Ведро по одному IP ПЕРЕД ведром попыток. Шире парного (человек с несколькими
	// формами под паролем не должен упираться), но ограничивает частоту, с которой
	// один адрес вообще заводит ключи в парном ведре: там ключ содержит slug из
	// адреса, то есть его выбирает клиент.
	unlockIPRatePerSec = 1.0 / 5.0
	unlockIPBurst      = 20

	// Вёдра записи на время (фаза 27). Выдача свободного времени — ведро по IP:
	// ручка читающая, но дешёвой её не назвать — это счёт занятого по диапазону плюс
	// расчёт сетки на горизонт. Двадцать запросов и один новый в секунду: листание дат
	// в пикере укладывается с запасом, обход горизонта пачкой — нет.
	slotsRatePerSec = 1.0
	slotsBurst      = 20

	// Ведро ХОЛДА — по паре «IP + slug», как у попыток пароля, и по той же причине:
	// по одному IP перебор одной формы закрывал бы человеку остальные, по одному slug
	// один атакующий закрывал бы форму всем.
	//
	// ⚠ СПИСЫВАЕТСЯ ДО ЛЮБОЙ ПРОВЕРКИ (design/booking.md §7): иначе перебором холдов
	// чужую форму можно заблокировать целиком — отказы стоили бы атакующему ничего.
	// Десять попыток и одна новая в 15 секунд: передумать и выбрать другое время
	// человек успевает, а занять весь день ботом — нет.
	holdRatePerSec = 1.0 / 15.0
	holdBurst      = 10

	// Ведро страницы отмены — по IP. Токен неперебираем (подпись HMAC), но подбор
	// всё равно должен упираться в стену, а сама страница дважды за минуту никому не
	// нужна: открыть, прочитать, нажать.
	cancelRatePerSec = 1.0 / 3.0
	cancelBurst      = 10

	// Жёсткий лимит на выдачу слота загрузки по IP (фаза 24, своё ведро). Ведро
	// уже, чем у приёма ответа, и это осознанно: каждый слот — строка в базе и
	// право записи в наш бакет, то есть чужие байты за наш счёт. Запас 10,
	// пополнение ~1 в 6 с: человек с формой на десяток вложений успевает всё
	// приложить, автоматический перебор упирается почти сразу.
	uploadRatePerSec = 1.0 / 6.0
	uploadBurst      = 10

	// Жёсткий лимит на POST визита по IP (своё ведро, ARCHITECTURE §4.6). Щедрее
	// приёма ответа: один человек за визит шлёт минимум два бикона, а
	// visibilitychange добавляет по одному на каждое переключение вкладки — ведро
	// уровня submit резало бы обычное поведение. Накрутку просмотров это не
	// исключает (ручка публичная на запись), а ограничивает: ущерб — неверное число
	// на своём же дашборде, не данные.
	visitRatePerSec = 1.0
	visitBurst      = 60

	// Колбэк входа через провайдера: ходит во внешний сервис, поэтому долбить
	// его чужими кодами не должно быть дешевле, чем логиниться. Чуть щедрее
	// логина: человек может честно промахнуться (отклонил согласие, вернулся,
	// попробовал снова), а цена ошибки здесь — не подбор пароля.
	oauthRatePerSec = 1.0 / 6.0
	oauthBurst      = 10

	// Сброс пароля (слайс B). Три ведра. forgot по IP: действие редкое (как
	// регистрация) — запас 5, ~1 в 30 с. forgot по email: чтобы нельзя было
	// завалить чужой ящик письмами с разных IP — запас 3, медленное пополнение
	// ~1 в 5 мин. reset по IP: перебор токенов + argon2 на каждый вызов, ведро
	// уровня логина — запас 5, ~1 в 12 с.
	forgotIPRatePerSec    = 1.0 / 30.0
	forgotIPBurst         = 5
	forgotEmailRatePerSec = 1.0 / 300.0
	forgotEmailBurst      = 3
	resetRatePerSec       = 1.0 / 12.0
	resetBurst            = 5

	// Подтверждение email (слайс C). verify по IP: перебор токенов — ведро уровня
	// сброса, запас 5, ~1 в 12 с. resend по пользователю: кнопка «отправить ещё
	// раз» — редкое действие, запас 3, медленное пополнение ~1 в 5 мин (не даём
	// слать письма пачками на свой же ящик).
	verifyRatePerSec = 1.0 / 12.0
	verifyBurst      = 5
	// aiRatePerSec/aiBurst — обращения к модели (сборка формы и чат, одно ведро на
	// обе ручки: кошелёк у них общий). Ключ ведра — АККАУНТ: вызов стоит денег
	// снаружи, и ограничивать надо того, кто платит, а не адрес, с которого пришли.
	//
	// Двенадцать в минуту при запасе на пять — темп разговора, а не сборки формы:
	// минута между репликами (прежнее число под одноразовую генерацию) означала бы,
	// что в чате нельзя переспросить. Настоящий потолок расхода держит квота тарифа,
	// ведро отвечает только за всплеск: залипшую кнопку и цикл в кабинете.
	aiRatePerSec = 1.0 / 5.0
	aiBurst      = 5

	resendRatePerSec = 1.0 / 300.0
	resendBurst      = 3

	// Смена пароля в настройках (фаза 23). Ведро по ПОЛЬЗОВАТЕЛЮ и щедрое по
	// сравнению с логином: перебирать тут нечего (сессия уже своя), режем только
	// поток argon2id — 64 МиБ на вызов. Три подряд (опечатался в текущем пароле —
	// пробуй ещё), дальше по одному в минуту.
	passwordChangeRatePerSec = 1.0 / 60.0
	passwordChangeBurst      = 3

	// Второй фактор (фаза 23, слайс F): включение и выключение — по
	// ПОЛЬЗОВАТЕЛЮ. За выключением стоит argon2id и шестизначный код, за
	// включением — генерация секрета; ни то ни другое не делают в цикле.
	twoFactorRatePerSec = 1.0 / 12.0
	twoFactorBurst      = 5

	// Второй шаг ВХОДА — своё ведро, по АККАУНТУ, и самое строгое из всех.
	// Причина в том, что здесь перебирают: пространство шестизначного кода —
	// 10^6, окно проверки ±1 держит валидными три значения сразу, то есть одна
	// попытка угадывает с вероятностью ~3·10⁻⁶. Ведро по IP такому перебору не
	// мешает (адреса дёшевы), а пропуск на второй шаг перевыдаётся паролем —
	// который в этом сценарии у атакующего уже есть.
	//
	// Запас 5 (просроченный код, опечатка, резервный код не с той строки),
	// дальше по одной попытке в минуту: живому человеку хватает, перебор при
	// таком темпе становится делом лет. Лока после N неудач нет сознательно —
	// см. комментарий у loginTwoFactor.
	loginTwoFactorRatePerSec = 1.0 / 60.0
	loginTwoFactorBurst      = 5

	// Удаление аккаунта (фаза 23, слайс G) — по ПОЛЬЗОВАТЕЛЮ. За ручкой argon2id
	// и код второго фактора, а нажимают её один раз в жизни: темп как у смены
	// пароля, три подряд на случай опечатки в подтверждении.
	deleteAccountRatePerSec = 1.0 / 60.0
	deleteAccountBurst      = 3

	// Загрузка аватара — по ПОЛЬЗОВАТЕЛЮ. Дорога не памятью, а процессором:
	// декод до 24 Мпикс, ресайз CatmullRom и два ре-энкода на каждый вызов.
	// Человек меняет картинку раз в полгода и в один заход пробует две-три —
	// отсюда запас 5 при пополнении раз в 20 секунд.
	avatarRatePerSec = 1.0 / 20.0
	avatarBurst      = 5

	// Печать PDF ответа (ADR §10). Два одновременных браузера — потолок для одной
	// машины, на которой рядом живёт Postgres: третий запрос ждёт слота, а не
	// поднимает третий браузер. Таймаут — на одну печать целиком (запрос к принтеру,
	// включая работу chromium).
	printConcurrency = 2
	printTimeout     = 30 * time.Second
	// Проверка связи с принтером при старте — секунда: он либо рядом (одна сеть
	// compose, локальный хост), либо не отвечает вовсе.
	printerPingTimeout = time.Second

	// Периодическая чистка истёкших сессий (ARCHITECTURE §4.4).
	sessionCleanupInterval = time.Hour
	sessionCleanupTimeout  = 30 * time.Second

	// Чистка истёкших токенов сброса пароля (живут 30 мин; часового прогона хватает).
	resetTokenCleanupTimeout = 30 * time.Second

	// Чистка истёкших токенов подтверждения email (живут 24 ч; тот же прогон).
	verificationTokenCleanupTimeout = 30 * time.Second
	// Чистка сирот-загрузок ходит и в базу, и в хранилище, поэтому времени ей
	// нужно больше, чем чисто-табличным задачам: порция до 200 объектов сносится
	// по одному запросу на объект.
	orphanFileCleanupTimeout = 2 * time.Minute

	// Диспетчер outbox (почтовая фаза): раз в интервал отправляет пачку готовых
	// писем. Интервал — компромисс «сброс пароля не должен ощутимо ждать» против
	// «не долбить провайдера вхолостую»; пачка ограничивает работу одного прогона.
	outboxDispatchInterval = 15 * time.Second
	outboxDispatchTimeout  = 30 * time.Second
	outboxBatch            = 50
	// Бэкофф ретраев доставки: первая неудача — 1 мин, дальше удвоение до потолка 1 ч.
	// outboxPrintsPerTick — сколько PDF-вложений диспетчер печатает за один проход.
	// Три при двух браузерах: печать 0.5–1 с, и без потолка пачка писем с вложениями
	// выела бы весь тик (15 с при таймауте 30 с), задержав письма без вложений —
	// в первую очередь сброс пароля, который едет той же очередью.
	outboxPrintsPerTick = 3

	outboxBackoffBase = time.Minute
	outboxBackoffMax  = time.Hour

	// Доставка в вебхуки (фаза 28) — СВОЙ проход, почта его не видит: у цели с
	// адресом во внешнем мире своё расписание, и мёртвый получатель не имеет
	// права задерживать письмо со сбросом пароля (ADR §10).
	//
	// Тик чаще почтового: ответ обязан уезжать «через секунды», а пустой проход
	// стоит одного запроса — целей без очереди выборка не берёт.
	webhookDispatchInterval = 5 * time.Second
	// Таймаут прохода: цель везёт до 10 ответов, по 10 с на запрос в худшем
	// случае, плюс запас на разбор тела; недоделанное уедет следующим проходом,
	// строки очереди на месте.
	webhookDispatchTimeout = 2 * time.Minute
	// Уборка очереди вебхуков: ответы, прождавшие дольше срока хранения.
	webhookQueueCleanupInterval = time.Hour
	webhookQueueCleanupTimeout  = 30 * time.Second
	// Доставка в Google Таблицы (0065) — второй такой же проход, со своим
	// расписанием у каждой связки. Тик тот же, что у вебхуков: ответ обязан
	// уезжать «через секунды», а пустой проход стоит одного запроса.
	sheetDispatchInterval = 5 * time.Second
	// Таймаут прохода: связка везёт до 200 ответов ОДНИМ запросом к Google,
	// плюс чтение шапки листа перед ним; недоделанное уедет следующим проходом,
	// строки очереди на месте.
	sheetDispatchTimeout = 2 * time.Minute
	// Уборка очереди Таблиц — тот же срок и тот же час, что у вебхуков.
	sheetQueueCleanupInterval = time.Hour
	sheetQueueCleanupTimeout  = 30 * time.Second
	// Ведро кнопки «Проверить»: шесть проверок в минуту на человека. Кнопка
	// ходит по адресу, который человек только что ввёл, и без ведра ею можно
	// было бы стучать в чужой сервер с нашего IP.
	webhookTestRatePerSec = 0.1
	webhookTestBurst      = 6

	// Периодический сбор простаивающих вёдер лимитеров (TD-5): ключ ведра — реальный
	// IP (после TD-1) либо id пользователя, поэтому карта иначе растёт неограниченно.
	// GC удаляет только пополнившиеся дополна ведра, а время полного пополнения у
	// вёдер разное — от минуты (login, submit, visit) до пятнадцати (resend, forgot
	// по email, смена почты). Интервал выбран по быстрым вёдрам: они же и растут
	// быстрее всех, потому что ключуются IP. Медленные переживают лишний проход и
	// уезжают на следующем — их карты и так малы.
	ratelimitGCInterval = 10 * time.Minute
	// secretMailRetention — сколько доставленное письмо с кодом лежит в outbox
	// до уборки. Не ноль: диагностика «письмо ушло или нет» должна оставаться
	// возможной хотя бы в пределах часа, а сам код живёт десять минут и к этому
	// времени уже недействителен.
	secretMailRetention = time.Hour
)

// senderAddress и senderName — адрес и имя из MAIL_FROM. Пустая строка, если
// разобрать не вышло: обе строки нужны одной подписи в кабинете, и падать из-за неё
// нельзя.
// formGenerator — модель для сборки формы текстом. Выключенный контур получает
// ai.Disabled: «генерации здесь нет» становится обычным ответом подсистемы, а не
// проверкой на nil в каждой ручке.
func formGenerator(cfg config.Config, log *slog.Logger) forms.Generator {
	if !cfg.AIEnabled() {
		log.Info("ai generation disabled (AI_TRANSPORT=off)")
		return ai.Disabled{}
	}
	log.Info("ai generation enabled", slog.String("model", cfg.AIModel))
	return ai.NewClient(ai.Options{
		BaseURL:         cfg.AIBaseURL,
		APIKey:          cfg.AIAPIKey,
		Model:           cfg.AIModel,
		Project:         cfg.AIProject,
		ReasoningEffort: cfg.AIReasoningEffort,
		Log:             log,
	})
}

// hostOf — хост адреса из конфига. Адреса проверены при старте (config), так что
// неразборчивый здесь не встретится; пустой хост safehttp просто не запретит.
func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func senderAddress(from string) string {
	addr, err := netmail.ParseAddress(from)
	if err != nil {
		return ""
	}
	return addr.Address
}

func senderName(from string) string {
	addr, err := netmail.ParseAddress(from)
	if err != nil {
		return ""
	}
	return addr.Name
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		// До загрузки конфига уровень неизвестен — ошибку старта пишем временным
		// логгером на stderr (её видно всегда).
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("load config", slog.String("error", err.Error()))
		os.Exit(1)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))

	if len(os.Args) > 1 {
		if err := runCommand(os.Args[1:], cfg, log); err != nil {
			log.Error("command failed", slog.String("command", os.Args[1]), slog.String("error", err.Error()))
			os.Exit(1)
		}
		return
	}

	if err := runServer(cfg, log); err != nil {
		log.Error("server failed", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

func runCommand(args []string, cfg config.Config, log *slog.Logger) error {
	switch args[0] {
	case "migrate":
		return runMigrate(args[1:], cfg, log)
	case "seed":
		return runSeed(cfg, log)
	case "seed-user":
		return runSeedUser(args[1:], cfg, log)
	case "seed-visits":
		return runSeedVisits(args[1:], cfg, log)
	default:
		return fmt.Errorf("unknown command %q (known: migrate, seed, seed-user, seed-visits)", args[0])
	}
}

func runServer(cfg config.Config, log *slog.Logger) error {
	pool, err := postgres.NewPool(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Исходящая почта (почтовая фаза): транспорт выбирается по смысловому флагу
	// MAIL_TRANSPORT, а не по имени окружения. log — письмо «доставляется» записью в
	// лог (dev); smtp — один SMTP-клиент на прод (Postbox) и prod-local (Mailpit),
	// различие лишь в MAIL_SMTP*. Строится раньше authSvc: сброс пароля кладёт письмо
	// через этот сервис.
	var mailer mail.Mailer
	switch cfg.MailTransport {
	case config.MailTransportLog:
		mailer = mail.LogMailer{Log: log, From: cfg.MailFrom}
	case config.MailTransportSMTP:
		mailer = mail.SMTPMailer{
			Host:     cfg.MailSMTPHost,
			Port:     cfg.MailSMTPPort,
			Username: cfg.MailSMTPUsername,
			Password: cfg.MailSMTPPassword,
			TLS:      smtpTLSMode(cfg.MailSMTPTLS),
			From:     cfg.MailFrom,
			Log:      log,
		}
	default:
		// config.Load уже отвалидировал список — сюда не дойдём; страховка на будущее.
		return fmt.Errorf("unsupported MAIL_TRANSPORT %q", cfg.MailTransport)
	}
	mailSvc := mail.NewService(pool, mail.Repo{}, mailer, log, outboxBatch,
		mail.Backoff{Base: outboxBackoffBase, Max: outboxBackoffMax})

	// Ключ шифрования секретов второго фактора выводится HKDF от того же
	// FORM_TOKEN_SECRET (своей env-переменной нет сознательно — спека §6).
	authSvc := auth.NewService(pool, postgres.TxRunner{Pool: pool}, auth.Repo{}, mailSvc, auth.DefaultSessionTTL, cfg.AppOrigin).
		WithLoginCodeKey(cfg.FormTokenSecret)
	loginLimiter := ratelimit.NewTokenBucket(loginRatePerSec, loginBurst)
	registerLimiter := ratelimit.NewTokenBucket(registerRatePerSec, registerBurst)
	// Именованной переменной, а не выражением в вызове: ведро ключуется id
	// аккаунта, и без чистки его карта растёт по числу входивших.
	loginTwoFactorLimiter := ratelimit.NewTokenBucket(loginTwoFactorRatePerSec, loginTwoFactorBurst)
	authHandler := auth.NewHandler(authSvc, loginLimiter, registerLimiter, cfg.CookieSecure, cfg.AppOrigin, cfg.TrustedProxy).
		WithTwoFactorLogin(loginTwoFactorLimiter)

	// Сброс пароля (слайс B): три ведра — forgot по IP и по email, reset по IP.
	forgotIPLimiter := ratelimit.NewTokenBucket(forgotIPRatePerSec, forgotIPBurst)
	forgotEmailLimiter := ratelimit.NewTokenBucket(forgotEmailRatePerSec, forgotEmailBurst)
	resetLimiter := ratelimit.NewTokenBucket(resetRatePerSec, resetBurst)
	authHandler = authHandler.WithPasswordReset(forgotIPLimiter, forgotEmailLimiter, resetLimiter)
	verifyLimiter := ratelimit.NewTokenBucket(verifyRatePerSec, verifyBurst)
	resendLimiter := ratelimit.NewTokenBucket(resendRatePerSec, resendBurst)
	authHandler = authHandler.WithEmailVerification(verifyLimiter, resendLimiter)
	// Именованными переменными, а не выражениями в литерале: иначе до вёдер не
	// добраться из задачи ratelimit-gc — их карты растут без чистки.
	passwordChangeLimiter := ratelimit.NewTokenBucket(passwordChangeRatePerSec, passwordChangeBurst)
	twoFactorLimiter := ratelimit.NewTokenBucket(twoFactorRatePerSec, twoFactorBurst)
	deleteAccountLimiter := ratelimit.NewTokenBucket(deleteAccountRatePerSec, deleteAccountBurst)
	avatarLimiter := ratelimit.NewTokenBucket(avatarRatePerSec, avatarBurst)
	authHandler = authHandler.WithAccount(auth.AccountLimits{
		PasswordChange: passwordChangeLimiter,
		TwoFactor:      twoFactorLimiter,
		DeleteAccount:  deleteAccountLimiter,
		Avatar:         avatarLimiter,
	})

	// Вход через провайдеров (фаза 11). Нет ключей в окружении — реестр пуст,
	// эндпоинты отдают 404, кабинет работает как раньше.
	oauthProviders := map[string]oauth.Provider{}
	oauthLimiter := ratelimit.NewTokenBucket(oauthRatePerSec, oauthBurst)
	if cfg.YandexOAuthEnabled() {
		oauthProviders["yandex"] = oauth.NewYandex(
			cfg.YandexOAuthClientID,
			cfg.YandexOAuthClientSecret,
			cfg.AppOrigin+"/api/v1/auth/oauth/yandex/callback",
		)
	}
	authHandler = authHandler.WithOAuth(authSvc, oauthProviders, oauthLimiter, cfg.FormTokenSecret)
	log.Info("oauth providers configured", slog.Int("count", len(oauthProviders)))

	// Единая точка лимитов тарифа (фаза 17): её спрашивают чтение воронки, приём
	// ответа и создание пространства. Собирается до всех потребителей.
	entitlementsSvc := entitlements.NewService(pool, entitlements.Repo{}, time.Now)

	// Права в пространстве (фаза 18): их спрашивает forms — поэтому workspaces
	// собирается раньше него. Обратной зависимости нет: workspaces знает про
	// тариф, но не про формы.
	// Писем модуль не шлёт: приглашение по адресу почты вырезано, зовут ссылкой,
	// и передаёт её человек сам (ADR §10). Вместе с письмом ушло и ведро отправки.
	workspacesSvc := workspaces.NewService(pool, postgres.TxRunner{Pool: pool}, workspaces.Repo{}, entitlementsSvc, cfg.AppOrigin)
	// Удаление аккаунта спрашивает у пространств, не осиротеет ли команда
	// (слайс G). Связь односторонняя и подключается здесь, потому что импортом
	// её не выразить: workspaces уже стоит на RequireAuth из auth.
	authSvc.WithTeams(workspacesSvc)
	workspacesHandler := workspaces.NewHandler(workspacesSvc, authHandler.RequireAuth, authHandler.RequireCSRF)

	// Секрет токена формы: из него выводятся ключ шифрования пароля формы и подпись
	// токенов разблокировки (0047). Без него пароль поставить нельзя, а уже
	// стоящий не пускает никого — отказ, а не работа без защиты.
	//
	// Модель: настроенный контур получает клиента провайдера, ненастроенный —
	// ai.Disabled, и тогда ручка генерации отвечает 404 (контур без провайдера
	// обязан работать целиком, фаза 26).
	formsSvc := forms.NewService(pool, postgres.TxRunner{Pool: pool}, forms.Repo{}, workspacesSvc, entitlementsSvc).
		WithSecret(cfg.FormTokenSecret).
		WithAI(formGenerator(cfg, log))
	aiLimiter := ratelimit.NewTokenBucket(aiRatePerSec, aiBurst)
	formsHandler := forms.NewHandler(formsSvc, authHandler.RequireAuth, authHandler.RequireCSRF).
		WithAILimiter(aiLimiter).
		// Письмо о новом ответе без авторских правок — для бланка в настройках формы.
		// Адрес и имя разбираются из MAIL_FROM («Trillix <no-reply@…>»), тема живёт
		// в самом шаблоне письма. Разбор не удался — строки пустые, и кабинет
		// нарисует описание вместо значения.
		WithNotifyMail(senderAddress(cfg.MailFrom), senderName(cfg.MailFrom),
			mail.DefaultSubject(mail.TemplateSubmissionNew)).
		WithRespondentMail(senderAddress(cfg.MailFrom), senderName(cfg.MailFrom),
			mail.DefaultSubject(mail.TemplateRespondentReceipt))

	// Шаблоны форм (0059). Формы модулю нужны с двух сторон: прочитать черновик,
	// который сохраняют как шаблон, и завести форму из шаблона — оба права
	// проверяет сам formsSvc. Флаг администратора спрашивается у auth: колонка
	// живёт у users, и читать чужую таблицу модуль не вправе.
	// Уведомления кабинета (ADR §10). Права спрашиваются у workspaces: повод
	// адресуется всем, кому можно ДЕЙСТВИЕ повода. Продюсеров у сервиса пока нет —
	// слайс A даёт таблицу, реестр и уборщик; ставить поводы начнут следующие
	// слайсы (приём ответа и доставщики интеграций).
	notifySvc := notify.NewService(pool, notify.Repo{}, workspacesSvc)
	templatesSvc := templates.NewService(pool, templates.Repo{}, workspacesSvc, formsSvc, authSvc)
	templatesHandler := templates.NewHandler(templatesSvc, authHandler.RequireAuth, authHandler.RequireCSRF)

	// Интеграции формы (фаза 25). Провайдер — интерфейс, и типизированный nil
	// сюда класть НЕЛЬЗЯ: `(*Google)(nil)` в интерфейсе не равен nil, и сервис
	// считал бы себя настроенным. Отсюда объявление переменной интерфейсного
	// типа и присваивание только при заданных ключах.
	var googleProvider integrations.Provider
	if cfg.GoogleOAuthEnabled() {
		googleProvider = integrations.NewGoogle(
			cfg.GoogleOAuthClientID,
			cfg.GoogleOAuthClientSecret,
			cfg.AppOrigin+"/api/v1/integrations/google/callback",
		)
	}
	// Вебхуки (фаза 28): запрос по адресу пользователя идёт только через safehttp
	// с боевым Guard (ADR §10). Свои хосты запрещены отдельно: они публичные, и
	// Guard их пропустил бы.
	webhookEgress := safehttp.New(safehttp.PublicOnly{}, safehttp.Options{
		OwnHosts: []string{hostOf(cfg.AppOrigin), hostOf(cfg.PublicRendererBaseURL)},
	})
	integrationsSvc := integrations.NewService(pool, postgres.TxRunner{Pool: pool}, integrations.Repo{}, workspacesSvc, formsSvc, googleProvider, cfg.FormTokenSecret).
		WithPicker(cfg.GooglePickerAPIKey).
		WithWebhooks(integrations.Repo{}, webhookEgress)
	// Расписания записи на время (фаза 27). Права спрашиваются у workspaces, квота
	// числа расписаний — у entitlements. Транзакция нужна одному действию — переносу
	// записи: лок слота, счёт мест и правка обязаны быть одной.
	bookingSvc := booking.NewService(pool, postgres.TxRunner{Pool: pool}, booking.Repo{}, workspacesSvc, entitlementsSvc)
	bookingHandler := booking.NewHandler(bookingSvc, authHandler.RequireAuth, authHandler.RequireCSRF)
	// Подтверждение брони в приёме ответа: работает внутри транзакции submissions,
	// поэтому ни пула, ни своих часов ему не даётся.
	// Ссылка отмены живёт у подтверждения: подпись требует секрета, и раздавать его
	// приёму ответа незачем. Адрес — публичного рендерера: страницу отмены отдаёт он.
	bookingConfirmer := booking.NewConfirmer(booking.Repo{}).
		WithCancelLinks(booking.DeriveCancelSecret(cfg.FormTokenSecret), cfg.PublicRendererBaseURL)
	// Стоп-кран удаления: живая будущая запись держит и ответ, и форму (ADR §10).
	bookingGuard := booking.NewGuard(pool, booking.Repo{})
	// Отмена по ссылке из письма. Секрет производный — с отдельной меткой назначения,
	// как у разблокировки формы и токена печати; ротация FORM_TOKEN_SECRET гасит все
	// выданные ссылки (раннбук ротации).
	bookingCancelSvc := booking.NewCancelService(pool, booking.Repo{},
		booking.DeriveCancelSecret(cfg.FormTokenSecret))
	// Публичная половина записи: свободное время и холд. Своя транзакция ей нужна —
	// лок слота, счёт занятого и вставка обязаны быть одной.
	bookingPublicSvc := booking.NewPublicService(pool, postgres.TxRunner{Pool: pool}, booking.Repo{}, formsSvc)
	bookingPublic := booking.NewPublicHandler(
		bookingPublicSvc,
		ratelimit.NewTokenBucket(slotsRatePerSec, slotsBurst),
		ratelimit.NewTokenBucket(holdRatePerSec, holdBurst),
		cfg.TrustedProxy,
	).WithCancel(bookingCancelSvc, ratelimit.NewTokenBucket(cancelRatePerSec, cancelBurst))

	webhookTestLimiter := ratelimit.NewTokenBucket(webhookTestRatePerSec, webhookTestBurst)
	integrationsHandler := integrations.NewHandler(integrationsSvc, authHandler.RequireAuth, authHandler.RequireCSRF,
		cfg.AppOrigin, cfg.CookieSecure, cfg.FormTokenSecret, webhookTestLimiter)
	log.Info("integrations configured", slog.Bool("google", cfg.GoogleOAuthEnabled()))

	formTokenLimiter := ratelimit.NewTokenBucket(formTokenRatePerSec, formTokenBurst)
	formsPublic, err := forms.NewPublicHandler(formsSvc, cfg.FormTokenSecret, cfg.PublicRendererBaseURL, cfg.OGImageURL, cfg.PublicRendererIndexPath,
		formTokenLimiter, cfg.TrustedProxy)
	if err != nil {
		return fmt.Errorf("init public forms handler: %w", err)
	}
	unlockLimiter := ratelimit.NewTokenBucket(unlockRatePerSec, unlockBurst)
	unlockIPLimiter := ratelimit.NewTokenBucket(unlockIPRatePerSec, unlockIPBurst)
	formsPublic = formsPublic.WithUnlockLimiter(unlockLimiter, unlockIPLimiter)
	// Факты расписания в теле публичной формы (фаза 27): пояс, число мест и показ
	// остатка. Без них пикер собрать не из чего, а с формой они едут одним запросом.
	formsPublic = formsPublic.WithBooking(bookingPublicSvc)

	blobClient := blob.New(blob.Config{
		Endpoint:  cfg.S3Endpoint,
		Region:    cfg.S3Region,
		AccessKey: cfg.S3AccessKey,
		SecretKey: cfg.S3SecretKey,
		PathStyle: cfg.S3PathStyle,
	})
	mediaSvc := media.NewService(formsSvc, blobClient, cfg.S3MediaBucket)
	mediaHandler := media.NewHandler(mediaSvc, authHandler.RequireAuth, authHandler.RequireCSRF)
	// Аватар пишет auth (колонка users.avatar_key его), а картинку хранит media.
	// Связь подключается здесь, а не импортом: media стоит на RequireAuth из
	// auth — тот же случай, что WithTeams выше.
	authSvc.WithAvatars(mediaSvc)

	// Файлы в ответах (фаза 24): свой бакет — приватный, у картинок форм политика
	// несовместимая (те раздаются анонимно).
	// Второй клиент — ТОЛЬКО чтобы подписывать адреса для браузера: имя хоста входит
	// в подпись, а респондент видит хранилище по внешнему адресу (в контуре, где
	// Go ходит к нему по внутренней сети, они разные).
	publicBlobClient := blob.New(blob.Config{
		Endpoint:  cfg.S3PublicEndpoint,
		Region:    cfg.S3Region,
		AccessKey: cfg.S3AccessKey,
		SecretKey: cfg.S3SecretKey,
		PathStyle: cfg.S3PathStyle,
	})
	filesSvc := answerfiles.NewService(pool, answerfiles.Repo{},
		answerfiles.NewBucket(publicBlobClient, blobClient, cfg.S3FilesBucket), formsSvc, entitlementsSvc)
	// Связь двусторонняя и потому ставится здесь: answerfiles спрашивает у forms
	// доступ, forms зовёт answerfiles при удалении формы. Обратный импорт замкнул
	// бы цикл.
	formsSvc.WithFiles(filesSvc)
	formsSvc.WithBookingGuard(bookingGuard)
	// Пространству файлы нужны по той же причине: его удаление уносит каскадом
	// формы, а с ними — записи о загрузках вместе с ключами объектов.
	workspacesSvc.WithFiles(filesSvc)
	filesHandler := answerfiles.NewHandler(filesSvc, authHandler.RequireAuth)
	uploadLimiter := ratelimit.NewTokenBucket(uploadRatePerSec, uploadBurst)
	filesPublic := answerfiles.NewPublicHandler(filesSvc, uploadLimiter, cfg.FormTokenSecret,
		submissions.DefaultMinFillTime, cfg.TrustedProxy)

	// Справочник геолокации: пустой GEO_DB_PATH — законная конфигурация (гео на
	// контуре нет, блок стран и городов не рисуется), а вот заданный, но
	// нечитаемый путь роняет старт: молча собирать визиты без гео, когда его
	// просили, значит обнаружить это через месяц по пустому экрану.
	geoSvc, err := geo.Open(cfg.GeoDBPath)
	if err != nil {
		return fmt.Errorf("geo database: %w", err)
	}
	if geoSvc != nil {
		log.Info("geo database loaded", slog.String("path", cfg.GeoDBPath))
	}

	visitLimiter := ratelimit.NewTokenBucket(visitRatePerSec, visitBurst)
	// Секрет аналитики выводится из секрета токена формы (см. deriveVisitorSecret):
	// своей переменной окружения у неё нет — платить настройкой за одну карточку
	// владельцу не за что.
	visitsSvc := visits.NewService(pool, formsSvc, entitlementsSvc, visits.Repo{}, geoSvc, cfg.FormTokenSecret)
	visitsPublic := visits.NewPublicHandler(visitsSvc, visitLimiter, cfg.FormTokenSecret, cfg.TrustedProxy)
	visitsHandler := visits.NewHandler(visitsSvc, authHandler.RequireAuth)
	entitlementsHandler := entitlements.NewHandler(entitlementsSvc, workspacesSvc, authHandler.RequireAuth)

	submitLimiter := ratelimit.NewTokenBucket(submitRatePerSec, submitBurst)
	respondentMailLimiter := ratelimit.NewTokenBucket(respondentMailRatePerSec, respondentMailBurst)
	submissionsSvc := submissions.NewService(pool, postgres.TxRunner{Pool: pool}, formsSvc, visitsSvc, mailSvc, entitlementsSvc, submissions.Repo{}, cfg.AppOrigin).
		WithFiles(filesSvc).
		// Подтверждение записи (фаза 27): холд становится бронью в той же
		// транзакции, что принимает ответ, — время записи уезжает в сам ответ.
		WithBookings(bookingConfirmer).
		WithBookingGuard(bookingGuard).
		// Организатор приглашения — адрес отправителя контура: приглашение без
		// ORGANIZER часть клиентов не показывает вовсе.
		WithBookingMail(cfg.MailFrom).
		// Адрес публичного рендерера нужен подвалу письма респонденту: в нём стоит
		// ссылка на саму форму, а собрать её из origin кабинета нельзя.
		WithRespondentMail(cfg.PublicRendererBaseURL, respondentMailLimiter)
	// Доставка ответов в таблицы: строки ответа читает модуль submissions, и
	// сеттером, а не аргументом конструктора, — тот собран выше и ему самому
	// интеграции уже не нужны (ответ встаёт в очередь связки веткой CTE приёма).
	// Письмо об отмене записи: адрес получателя живёт в ОТВЕТЕ формы, поэтому его
	// ставит модуль ответов, а зовёт — тот, кто отменяет (ссылка из письма и кабинет).
	// Сеттеры мутируют сам сервис и возвращают его же: хендлеры, собранные выше,
	// держат тот же указатель, поэтому присваивать результат не надо.
	bookingCancelSvc.WithNotifier(submissionsSvc)
	bookingSvc.WithNotifier(submissionsSvc)
	// Повод «новые ответы» ставит приём ответа, гасит открытие таблицы. Сеттером, а
	// не аргументом конструктора: у приёма ответа и так девять коллабораторов.
	submissionsSvc = submissionsSvc.WithNotifications(notifySvc)
	integrationsSvc = integrationsSvc.WithDelivery(submissionsSvc)

	submissionsPublic := submissions.NewPublicHandler(submissionsSvc, submitLimiter, cfg.FormTokenSecret, submissions.DefaultMinFillTime, cfg.TrustedProxy)
	submissionsHandler := submissions.NewHandler(submissionsSvc, authHandler.RequireAuth, authHandler.RequireCSRF)
	// Печать PDF ответа (ADR §10). Клиент есть только там, где настроен принтер:
	// без него ручка честно отвечает 503, а не молчит. Семафор ограничивает число
	// одновременно поднятых браузеров — защищаем свою машину, на которой рядом
	// работает Postgres.
	if cfg.PrinterURL != "" {
		printClient := printer.New(cfg.PrinterURL, printConcurrency, printTimeout)
		submissionsHandler = submissionsHandler.WithPrinter(printClient, cfg.FormTokenSecret)
		// Вторая поверхность печати — вложение в письме о новом ответе. Тот же клиент
		// и тот же семафор: два браузера на машину считаются на всех потребителей
		// вместе, а не каждым по отдельности.
		mailSvc = mailSvc.WithAttachments(
			submissions.NewPrintAttachments(submissionsSvc, printClient, cfg.FormTokenSecret),
			outboxPrintsPerTick)
		// Проверяем связь СРАЗУ: опечатка в адресе (классика — прод-адрес
		// http://printer:8090 в dev, где такого имени нет) иначе всплывёт только при
		// первом клике по «Скачать PDF», у человека, который её не делал. Отказ не
		// роняет старт: печать не критична, а принтер может подняться следом.
		pingCtx, cancelPing := context.WithTimeout(context.Background(), printerPingTimeout)
		err := printClient.Ping(pingCtx)
		cancelPing()
		if err != nil {
			log.Warn("printer configured, but does not answer",
				slog.String("url", cfg.PrinterURL), slog.String("error", err.Error()))
		} else {
			log.Info("printer configured", slog.String("url", cfg.PrinterURL))
		}
	}

	routes := []httpserver.RouteRegistrar{
		authHandler.Routes, authHandler.OAuthRoutes, authHandler.AccountRoutes,
		workspacesHandler.Routes, formsHandler.Routes, formsPublic.Routes,
		submissionsPublic.Routes, submissionsHandler.Routes, mediaHandler.Routes,
		filesPublic.Routes, filesHandler.Routes,
		visitsPublic.Routes, visitsHandler.Routes, entitlementsHandler.Routes,
		integrationsHandler.Routes, bookingHandler.Routes, bookingPublic.Routes,
		templatesHandler.Routes,
	}

	// Печатная страница ответа (ADR §10). Путь задаётся явно на каждом контуре
	// (PRINT_PAGE_PATH); пусто — печати на контуре нет, и ручка PDF отвечает 503.
	if path := cfg.PrintPagePath; path != "" {
		printPage, err := submissions.NewPrintPageHandler(submissionsSvc, cfg.FormTokenSecret, path)
		if err != nil {
			return fmt.Errorf("init print page handler: %w", err)
		}
		routes = append(routes, printPage.Routes)
		log.Info("print page configured", slog.String("path", path))
	}

	srv := httpserver.New(cfg.HTTPAddr, log, pool, routes...)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Фоновые периодические задачи живут, пока не отменён ctx (SIGINT/SIGTERM).
	tasks := periodic.NewRunner(log)
	tasks.Start(ctx, periodic.Task{
		Name:     "session-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, sessionCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredSessions(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired sessions purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "reset-token-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredPasswordResetTokens(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired password reset tokens purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	// Второй фактор (0056): протухшие коды и знакомства с браузерами. Уборка,
	// а не защита: срок и того и другого проверяется в самих запросах, здесь
	// только освобождается место.
	tasks.Start(ctx, periodic.Task{
		Name:     "login-code-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredLoginCodes(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired login codes purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "known-device-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredKnownDevices(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired known devices purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	// А ЭТО — не уборка места, а защита: письмо с кодом несёт действующий
	// секрет, доставленные строки outbox не удаляются сами, и открытая копия
	// кода рядом с его HMAC в базе сделала бы хранение под HMAC декоративным.
	tasks.Start(ctx, periodic.Task{
		Name:     "secret-mail-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := mailSvc.PurgeDeliveredSecrets(ctx, secretMailRetention)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("delivered secret mail purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "join-link-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := workspacesSvc.PurgeExpiredJoinLinks(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("spent join links purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	// Протухшие холды записи (фаза 27). ЭТО УБОРКА, А НЕ ОСВОБОЖДЕНИЕ ВРЕМЕНИ: место
	// возвращается в оборот само — счёт занятого не считает истёкшие холды, — и
	// заминка задачи ни на что не влияет. Здесь убираются строки брошенных вкладок,
	// которые иначе копились бы вечно.
	//
	// Отсрочка вдвое больше срока холда: истёкший холд ещё может стать записью на
	// отправке длинной анкеты (перезанятие, ADR §10), и сносить его в ту же секунду
	// значило бы гарантированно отказать тому, кто как раз дописывает ответ.
	tasks.Start(ctx, periodic.Task{
		Name:     "booking-hold-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := bookingCancelSvc.PurgeHolds(ctx, 2*domain.HoldTTL)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired booking holds purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	// Сироты загрузок: слот выдали, ответ не пришёл (фаза 24). Интервал тот же, что
	// у прочей уборки; порог возраста — сутки, потолок жизни токена формы.
	tasks.Start(ctx, periodic.Task{
		Name:     "answer-file-orphan-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, orphanFileCleanupTimeout)
			defer cancel()
			n, err := filesSvc.CleanupOrphans(ctx, time.Now())
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("orphan answer files purged", slog.Int("count", n))
			}
			return nil
		},
	})
	// Черновики ответов старше срока хранения (спека §10.5): черновик — наблюдение,
	// а не документ, и копить чужой неотправленный текст без причины нельзя.
	tasks.Start(ctx, periodic.Task{
		Name:     "partial-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			n, err := submissionsSvc.CleanupPartials(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("partial submissions purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	// Журнал доставок интеграции старше срока хранения (INTEGRATIONS.md §12):
	// диагностика месячной давности не отвечает на вопрос «почему вчера не
	// уехало», а таблица растёт со скоростью потока ответов.
	tasks.Start(ctx, periodic.Task{
		Name:     "integration-delivery-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			n, err := integrationsSvc.CleanupDeliveries(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("integration deliveries purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "verification-token-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, verificationTokenCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredEmailVerificationTokens(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired email verification tokens purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "outbox-dispatch",
		Interval: outboxDispatchInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, outboxDispatchTimeout)
			defer cancel()
			n, err := mailSvc.Dispatch(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("outbox messages delivered", slog.Int("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "webhook-delivery",
		Interval: webhookDispatchInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, webhookDispatchTimeout)
			defer cancel()
			n, err := integrationsSvc.DeliverWebhooks(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("webhook deliveries sent", slog.Int("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "sheet-delivery",
		Interval: sheetDispatchInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, sheetDispatchTimeout)
			defer cancel()
			n, err := integrationsSvc.DeliverSheets(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("sheet rows delivered", slog.Int("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "sheet-queue-cleanup",
		Interval: sheetQueueCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, sheetQueueCleanupTimeout)
			defer cancel()
			n, err := integrationsSvc.CleanupSheetQueue(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("sheet queue rows expired", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "webhook-queue-cleanup",
		Interval: webhookQueueCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, webhookQueueCleanupTimeout)
			defer cancel()
			n, err := integrationsSvc.CleanupWebhookQueue(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("webhook queue rows expired", slog.Int64("count", n))
			}
			return nil
		},
	})
	// Уведомления стареют: у ленты, в отличие от производного состояния, нет
	// способа забыть самой (ADR §10). Сроки — в internal/notify.
	tasks.Start(ctx, periodic.Task{
		Name:     "notification-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			n, err := notifySvc.Cleanup(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("notifications purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "ratelimit-gc",
		Interval: ratelimitGCInterval,
		Run: func(context.Context) error {
			// Сумма обязана перечислять ВСЕ созданные вёдра: забытое здесь ведро
			// не ломает лимит, а растит карту до конца жизни процесса.
			removed := loginLimiter.GC() + registerLimiter.GC() + submitLimiter.GC() + oauthLimiter.GC() +
				visitLimiter.GC() + formTokenLimiter.GC() +
				forgotIPLimiter.GC() + forgotEmailLimiter.GC() + resetLimiter.GC() +
				verifyLimiter.GC() + resendLimiter.GC() + loginTwoFactorLimiter.GC() +
				passwordChangeLimiter.GC() + twoFactorLimiter.GC() + deleteAccountLimiter.GC() + avatarLimiter.GC() +
				respondentMailLimiter.GC() + unlockLimiter.GC() + unlockIPLimiter.GC() +
				uploadLimiter.GC() + webhookTestLimiter.GC()
			if removed > 0 {
				log.Debug("rate-limit buckets evicted", slog.Int("count", removed))
			}
			return nil
		},
	})

	serveErr := make(chan error, 1)
	go func() {
		log.Info("http server listening", slog.String("addr", cfg.HTTPAddr))
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
	}

	// Graceful shutdown: дождаться активных запросов с потолком 15 секунд.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	// ctx уже отменён (stop по сигналу); дождаться остановки фоновых задач до
	// закрытия пула (defer), иначе чистка может выстрелить в закрытый пул.
	tasks.Wait()
	log.Info("http server stopped")
	return nil
}

// smtpTLSMode переводит валидированный конфиг MAIL_SMTP_TLS в режим транспорта.
// config уже отверг чужие значения при старте, поэтому default недостижим —
// оставлен страховкой (пусть безопасный: без шифрования наружу не пойдём молча).
func smtpTLSMode(v string) mail.TLSMode {
	switch v {
	case config.MailSMTPTLSStartTLS:
		return mail.TLSStartTLS
	case config.MailSMTPTLSImplicit:
		return mail.TLSImplicit
	default:
		return mail.TLSNone
	}
}
