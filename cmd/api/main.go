// Command api — composition root. Без аргументов запускает HTTP-сервер;
// подкоманда `migrate up|down` прогоняет миграции тем же бинарником.
package main

import (
	"context"
	"fmt"
	"log/slog"
	netmail "net/mail"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ka-shmd/trillix/internal/answerfiles"
	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/config"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/geo"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/media"
	"github.com/ka-shmd/trillix/internal/oauth"
	"github.com/ka-shmd/trillix/internal/periodic"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/printer"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
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
	// inviteRatePerSec/inviteBurst — приглашения: письмо уходит на ПРОИЗВОЛЬНЫЙ
	// адрес, поэтому ведро строже, чем у ручек, пишущих только своему владельцу.
	// Пять подряд (собрать команду за раз), дальше по одному в две минуты.
	inviteRatePerSec = 1.0 / 120.0
	inviteBurst      = 5

	resendRatePerSec = 1.0 / 300.0
	resendBurst      = 3

	// Смена пароля в настройках (фаза 23). Ведро по ПОЛЬЗОВАТЕЛЮ и щедрое по
	// сравнению с логином: перебирать тут нечего (сессия уже своя), режем только
	// поток argon2id — 64 МиБ на вызов. Три подряд (опечатался в текущем пароле —
	// пробуй ещё), дальше по одному в минуту.
	passwordChangeRatePerSec = 1.0 / 60.0
	passwordChangeBurst      = 3

	// Смена адреса (фаза 23, слайс D). Запрос — по ПОЛЬЗОВАТЕЛЮ и строгий:
	// письмо уходит на произвольный адрес из формы, то же соображение, что у
	// приглашений. Подтверждение — по IP, ведро уровня verify (перебор токенов).
	emailChangeRatePerSec  = 1.0 / 300.0
	emailChangeBurst       = 3
	confirmEmailRatePerSec = 1.0 / 12.0
	confirmEmailBurst      = 5

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

	// Периодический сбор простаивающих вёдер лимитеров (TD-5): ключ ведра — реальный
	// IP (после TD-1) либо id пользователя, поэтому карта иначе растёт неограниченно.
	// GC удаляет только пополнившиеся дополна ведра, а время полного пополнения у
	// вёдер разное — от минуты (login, submit, visit) до пятнадцати (resend, forgot
	// по email, смена почты). Интервал выбран по быстрым вёдрам: они же и растут
	// быстрее всех, потому что ключуются IP. Медленные переживают лишний проход и
	// уезжают на следующем — их карты и так малы.
	ratelimitGCInterval = 10 * time.Minute
)

// senderAddress и senderName — адрес и имя из MAIL_FROM. Пустая строка, если
// разобрать не вышло: обе строки нужны одной подписи в кабинете, и падать из-за неё
// нельзя.
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
		WithTOTPKey(cfg.FormTokenSecret)
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
	emailChangeLimiter := ratelimit.NewTokenBucket(emailChangeRatePerSec, emailChangeBurst)
	confirmEmailLimiter := ratelimit.NewTokenBucket(confirmEmailRatePerSec, confirmEmailBurst)
	twoFactorLimiter := ratelimit.NewTokenBucket(twoFactorRatePerSec, twoFactorBurst)
	deleteAccountLimiter := ratelimit.NewTokenBucket(deleteAccountRatePerSec, deleteAccountBurst)
	avatarLimiter := ratelimit.NewTokenBucket(avatarRatePerSec, avatarBurst)
	authHandler = authHandler.WithAccount(auth.AccountLimits{
		PasswordChange: passwordChangeLimiter,
		EmailChange:    emailChangeLimiter,
		ConfirmEmail:   confirmEmailLimiter,
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
	workspacesSvc := workspaces.NewService(pool, postgres.TxRunner{Pool: pool}, workspaces.Repo{}, entitlementsSvc, mailSvc, cfg.AppOrigin)
	// Приглашение — единственная ручка, шлющая письмо на произвольный адрес:
	// ведро по пользователю, темп как у повторного подтверждения почты.
	// Удаление аккаунта спрашивает у пространств, не осиротеет ли команда
	// (слайс G). Связь односторонняя и подключается здесь, потому что импортом
	// её не выразить: workspaces уже стоит на RequireAuth из auth.
	authSvc.WithTeams(workspacesSvc)
	inviteLimiter := ratelimit.NewTokenBucket(inviteRatePerSec, inviteBurst)
	workspacesHandler := workspaces.NewHandler(workspacesSvc, inviteLimiter, authHandler.RequireAuth, authHandler.RequireCSRF)

	// Секрет токена формы: из него выводятся ключ шифрования пароля формы и подпись
	// токенов разблокировки (0047). Без него пароль поставить нельзя, а уже
	// стоящий не пускает никого — отказ, а не работа без защиты.
	formsSvc := forms.NewService(pool, postgres.TxRunner{Pool: pool}, forms.Repo{}, workspacesSvc, entitlementsSvc).
		WithSecret(cfg.FormTokenSecret)
	formsHandler := forms.NewHandler(formsSvc, authHandler.RequireAuth, authHandler.RequireCSRF).
		// Письмо о новом ответе без авторских правок — для бланка в настройках формы.
		// Адрес и имя разбираются из MAIL_FROM («Trillix <no-reply@…>»), тема живёт
		// в самом шаблоне письма. Разбор не удался — строки пустые, и кабинет
		// нарисует описание вместо значения.
		WithNotifyMail(senderAddress(cfg.MailFrom), senderName(cfg.MailFrom),
			mail.DefaultSubject(mail.TemplateSubmissionNew)).
		WithRespondentMail(senderAddress(cfg.MailFrom), senderName(cfg.MailFrom),
			mail.DefaultSubject(mail.TemplateRespondentReceipt))

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
	integrationsSvc := integrations.NewService(pool, postgres.TxRunner{Pool: pool}, integrations.Repo{}, workspacesSvc, formsSvc, googleProvider, cfg.FormTokenSecret).
		WithPicker(cfg.GooglePickerAPIKey)
	integrationsHandler := integrations.NewHandler(integrationsSvc, authHandler.RequireAuth, authHandler.RequireCSRF,
		cfg.AppOrigin, cfg.CookieSecure, cfg.FormTokenSecret)
	log.Info("integrations configured", slog.Bool("google", cfg.GoogleOAuthEnabled()))

	formTokenLimiter := ratelimit.NewTokenBucket(formTokenRatePerSec, formTokenBurst)
	formsPublic, err := forms.NewPublicHandler(formsSvc, cfg.FormTokenSecret, cfg.PublicRendererBaseURL, cfg.OGImageURL, cfg.PublicRendererIndexPath,
		formTokenLimiter, cfg.TrustedProxy)
	if err != nil {
		return fmt.Errorf("init public forms handler: %w", err)
	}
	unlockLimiter := ratelimit.NewTokenBucket(unlockRatePerSec, unlockBurst)
	formsPublic = formsPublic.WithUnlockLimiter(unlockLimiter)

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
		// Адрес публичного рендерера нужен подвалу письма респонденту: в нём стоит
		// ссылка на саму форму, а собрать её из origin кабинета нельзя.
		WithRespondentMail(cfg.PublicRendererBaseURL, respondentMailLimiter)
	// Доставка ответов в таблицы (слайс C): пара «submissions ↔ integrations»
	// собирается сеттерами — каждый нужен другому, и в конструкторе такую пару
	// не собрать. Транспорт канала подключается к диспетчеру outbox ДО старта
	// периодической задачи, иначе канал без транспорта копил бы ретраи.
	submissionsSvc = submissionsSvc.WithIntegrations(integrationsSvc)
	integrationsSvc = integrationsSvc.WithDelivery(mailSvc, submissionsSvc)
	mailSvc = mailSvc.WithTransport(integrations.ChannelSheets, integrationsSvc)

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
		integrationsHandler.Routes,
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
	tasks.Start(ctx, periodic.Task{
		Name:     "invitation-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := workspacesSvc.PurgeExpiredInvitations(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("spent invitations purged", slog.Int64("count", n))
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
	tasks.Start(ctx, periodic.Task{
		Name:     "email-change-token-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, verificationTokenCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredEmailChangeTokens(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired email change tokens purged", slog.Int64("count", n))
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
		Name:     "ratelimit-gc",
		Interval: ratelimitGCInterval,
		Run: func(context.Context) error {
			// Сумма обязана перечислять ВСЕ созданные вёдра: забытое здесь ведро
			// не ломает лимит, а растит карту до конца жизни процесса.
			removed := loginLimiter.GC() + registerLimiter.GC() + submitLimiter.GC() + oauthLimiter.GC() +
				visitLimiter.GC() + inviteLimiter.GC() + formTokenLimiter.GC() +
				forgotIPLimiter.GC() + forgotEmailLimiter.GC() + resetLimiter.GC() +
				verifyLimiter.GC() + resendLimiter.GC() + loginTwoFactorLimiter.GC() +
				passwordChangeLimiter.GC() + emailChangeLimiter.GC() + confirmEmailLimiter.GC() +
				twoFactorLimiter.GC() + deleteAccountLimiter.GC() + avatarLimiter.GC() +
				respondentMailLimiter.GC() + unlockLimiter.GC()
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
