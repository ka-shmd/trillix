package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/token"
)

// defaultClosedMessage — текст экрана «приём закрыт» для формы без своего текста.
// Резолвится на сервере (не в рендерере), чтобы JSON-ручка и HTML-страница не
// разъехались в дефолте. Владелец задаёт свой в настройках (closed_message).
const defaultClosedMessage = "Приём ответов на эту форму закрыт."

// publicFormService — часть сервиса форм, нужная публичному транспорту.
type publicFormService interface {
	PublicForm(ctx context.Context, slug string) (PublicForm, error)
	// ShowBadge — решение о бейдже «Сделано в Trillix»: намерение автора (живая
	// колонка формы) плюс разрешение тарифа. Свойство выдачи, а не документа: и то
	// и другое спрашивается при заходе на форму (ADR §10).
	ShowBadge(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error)
	// CollectPartial — собирать ли черновики у этой формы прямо сейчас: намерение
	// автора (тумблер) плюс разрешение тарифа.
	CollectPartial(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error)
	// LinkPreviewFor — своя карточка ссылки, действующая прямо сейчас: намерение
	// автора плюс разрешение тарифа. nil = дефолты страницы.
	LinkPreviewFor(ctx context.Context, workspaceID uuid.UUID, p *domain.LinkPreview) (*domain.LinkPreview, error)
	// VerifyUnlock — пускать ли к содержимому формы, закрытой паролем (0047).
	// sealed — шифротекст пароля прямо сейчас; пустой = пароля нет, пропускаем всегда.
	VerifyUnlock(formID uuid.UUID, sealed []byte, tok string) error
	// Unlock сверяет названный пароль и выдаёт токен разблокировки со сроком.
	Unlock(ctx context.Context, slug, password string) (string, time.Time, error)
}

// UnlockHeader — заголовок, которым рендерер предъявляет токен разблокировки.
// Заголовок, а не cookie: встроенная в чужой сайт форма — третья сторона, и её
// cookie браузеры режут (design/form-password.md §3.4). Исключение одно —
// автосохранение черновика: последнее уходит через sendBeacon, который заголовков не
// умеет, и там токен едет в теле.
const UnlockHeader = "X-Form-Unlock"

// PublicHandler — публичный транспорт форм (без авторизации и CSRF): отдаёт схему
// опубликованной версии по slug. Отдельный от Handler ровно потому, что у этих
// роутов нет RequireAuth — их регистрирует composition root без приватных middleware.
type PublicHandler struct {
	svc           publicFormService
	tokenSecret   []byte
	publicBaseURL string // база рендерера: og:url на /r/{slug} и ссылка на форму
	ogImageURL    string // абсолютный URL картинки превью (og:image)
	// tokenLimiter — ведро выдачи токена времени. Не опционально: это единственное,
	// что вообще ограничивает заготовку токенов пачкой (ADR §10).
	tokenLimiter httpserver.RateLimiter
	// unlockLimiter — ведро попыток пароля, ключ «IP|slug» (0047). Не по одному
	// адресу: подбор одной формы закрывал бы человеку все остальные; не по одному
	// slug: один подбирающий закрывал бы форму всем участникам.
	unlockLimiter UnlockLimiter
	// unlockIPLimiter — обычное ведро по IP перед ним (см. Routes): ограничивает
	// частоту, с которой один адрес вообще создаёт ключи в ведре выше.
	unlockIPLimiter httpserver.RateLimiter
	trustedProxy    bool // за Caddy честный IP клиента — из X-Forwarded-For (TD-1)
	// indexPath — путь к собранному index.html рендерера. Пустой в dev: тогда /r не
	// обслуживается Go (форму отдаёт vite-dev), и index не читается вовсе.
	indexPath string
	// index — разобранный документ (см. indexDoc). Атомарный указатель, потому что
	// файл перечитывается на лету при подмене на диске: читатели идут без блокировки,
	// подмена — одной записью указателя.
	index atomic.Pointer[indexDoc]
	// booking — факты расписания записи (фаза 27). Сеттером, а не аргументом
	// конструктора: у форм без записи (подавляющее большинство) его вообще нет, а
	// цепочка зависимостей публичной формы и без того длинная. nil = записи на
	// контуре нет, поле booking всегда null.
	booking ScheduleFacts
	now     func() time.Time // подменяется в тестах
}

// ScheduleFacts — то, что публичная отдача формы спрашивает у модуля записи.
// Реализация — *booking.PublicService.
type ScheduleFacts interface {
	FactsFor(ctx context.Context, scheduleID *uuid.UUID) (*BookingFacts, error)
}

// BookingFacts — факты расписания в терминах forms: чужой тип сюда не тянем, иначе
// forms начнёт зависеть от booking (а booking уже зависит от forms).
type BookingFacts struct {
	Timezone      string
	MaxSeats      int
	ShowRemaining bool
}

// WithBooking подключает факты расписания.
func (h *PublicHandler) WithBooking(f ScheduleFacts) *PublicHandler {
	h.booking = f
	return h
}

// NewPublicHandler создаёт публичный транспорт форм. indexHTMLPath — путь к
// собранному index.html рендерера (прод); пустой в dev — тогда /r не обслуживается
// Go (форму отдаёт vite-dev). Непустой путь читается сразу: нечитаемый файл или
// отсутствие плейсхолдера — ошибка старта, а не первого запроса.
func NewPublicHandler(svc publicFormService, tokenSecret []byte, publicBaseURL, ogImageURL, indexHTMLPath string,
	tokenLimiter httpserver.RateLimiter, trustedProxy bool,
) (*PublicHandler, error) {
	h := &PublicHandler{
		svc:           svc,
		tokenSecret:   tokenSecret,
		publicBaseURL: strings.TrimRight(publicBaseURL, "/"),
		ogImageURL:    ogImageURL,
		tokenLimiter:  tokenLimiter,
		trustedProxy:  trustedProxy,
		now:           time.Now,
	}
	if indexHTMLPath != "" {
		doc, err := parseIndexHTML(indexHTMLPath)
		if err != nil {
			return nil, err
		}
		h.indexPath = indexHTMLPath
		h.index.Store(doc)
	}
	return h, nil
}

// UnlockLimiter — ведро попыток пароля по ключу «IP|slug». Реализация —
// ratelimit.TokenBucket; в тестах инжектируется пермиссивная (инвариант 6).
type UnlockLimiter interface {
	Allow(key string) bool
}

// WithUnlockLimiter подключает ведро попыток пароля. Сеттером, а не аргументом
// конструктора: его зовут из тестов публичной отдачи, которым пароль не нужен.
//
// МИНА: без него ручка разблокировки НЕ регистрируется вовсе (404). Молча пускать
// подбор без лимита нельзя (инвариант 6), а тихо работать без ручки — заметно сразу.
func (h *PublicHandler) WithUnlockLimiter(l UnlockLimiter, byIP httpserver.RateLimiter) *PublicHandler {
	h.unlockLimiter = l
	h.unlockIPLimiter = byIP
	return h
}

// Routes регистрирует публичные эндпоинты форм на общем mux: JSON-ручку рендерера
// (/public/v1) и — только когда задан собранный index.html (прод) — HTML-страницу
// формы с OG-мета (/r/{slug}). В dev /r отдаёт vite-dev, поэтому Go его не регит.
func (h *PublicHandler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /public/v1/forms/{slug}", h.get)
	limited := httpserver.RateLimitByIP(h.tokenLimiter, h.trustedProxy, "слишком много запросов")
	mux.Handle("GET /public/v1/form-token", limited(http.HandlerFunc(h.formToken)))
	if h.unlockLimiter != nil {
		// ДВА лимитера, и это не перестраховка. Внешний — по IP, как у всех прочих
		// публичных ручек с телом: без него один адрес льёт запросы с произвольной
		// частотой. Внутренний — по паре «IP + slug», он и есть барьер подбора.
		//
		// МИНА: без внешнего ключи внутреннего ведра задаёт АТАКУЮЩИЙ (slug приходит
		// из адреса), и карта лимитера растёт на каждый новый slug до ближайшей
		// сборки мусора — то есть ведро подбора само становится способом съесть память.
		unlockLimited := httpserver.RateLimitByIP(h.unlockIPLimiter, h.trustedProxy, "слишком много попыток")
		mux.Handle("POST /public/v1/forms/{slug}/unlock", unlockLimited(http.HandlerFunc(h.unlock)))
	}
	if h.indexPath != "" {
		mux.HandleFunc("GET /r/{slug}", h.getHTML)
		// Страница отмены записи (фаза 27) — та же оболочка рендерера, без головы
		// формы: до разбора токена о форме ничего не известно.
		mux.HandleFunc("GET /cancel/{token}", h.getCancelHTML)
	}
}

// publicFormResponse — тело GET /public/v1/forms/{slug}.
//
// Токена времени здесь НЕТ и быть не должно: ответ кэшируемый (max-age=60 плюс
// иммутабельный ETag), а значит его возраст измерял бы возраст записи в кэше
// браузера, а не время заполнения формы. Токен приезжает отдельной некэшируемой
// ручкой /public/v1/form-token — ADR §10.
type publicFormResponse struct {
	Title   string          `json:"title"`
	Version int32           `json:"version"`
	Schema  json.RawMessage `json:"schema"`
	// ShowBadge — рисовать ли бейдж «Сделано в Trillix». Решение СЕРВЕРА и
	// свойство выдачи, а не документа: в схеме лежит лишь намерение автора, а
	// разрешает его тариф (спека §9.4). Поле, а не вывод клиента из схемы, ровно
	// поэтому — тариф клиенту знать неоткуда и незачем.
	ShowBadge bool `json:"showBadge"`
	// CollectPartial — сохранять ли набранное до отправки. Решение СЕРВЕРА: тумблер
	// автора плюс разрешение тарифа прямо сейчас (даунгрейд останавливает сбор, как
	// и с бейджем). Рендерер по этому полю делает ровно две вещи — автосохраняет и
	// предупреждает респондента; разъехаться они не могут, потому что факт один.
	CollectPartial bool `json:"collectPartial"`
	// Progress — рисовать ли шкалу прогресса (индикатор шагов). В отличие от
	// ShowBadge и CollectPartial, это ЧИСТОЕ намерение автора, а не решение сервера:
	// тарифа у шкалы нет, спрашивать поверх намерения нечего. Полем, а не выводом
	// клиента из схемы, — потому что живёт оно в колонке формы, которой в снапшоте
	// версии нет.
	Progress bool `json:"progress"`
	// AutoJump/SaveLocally — поведение формы у респондента (0044): переходить на
	// следующую страницу сразу после ответа и хранить незавершённые ответы в браузере
	// дольше сессии. Как и Progress — чистое намерение автора, без тарифа.
	AutoJump    bool `json:"autoJump"`
	SaveLocally bool `json:"saveLocally"`
	// AllowBack — пускать ли респондента на пройденные страницы (0055): кнопка
	// «Назад» и клик по линии пройденного шага. Тоже чистое намерение автора.
	// Записи в истории браузера за этим флагом НЕТ ни при каком значении (решение
	// владельца 2026-09-07) — системная «Назад» уводит со страницы формы.
	AllowBack bool `json:"allowBack"`
	// Booking — факты расписания записи (фаза 27): пояс, сколько мест можно взять
	// одной записью и показывать ли остаток. null = у формы нет расписания, и вопрос
	// о времени (если он в схеме) живого выбора не получает.
	//
	// Полем, а не выводом клиента из схемы, по той же причине, что CollectPartial:
	// расписание живёт колонкой формы, и в снапшоте версии его нет вовсе.
	Booking *bookingFacts `json:"booking"`
}

// bookingFacts — то, что рендерер знает о расписании формы, не зная самого расписания.
type bookingFacts struct {
	Timezone      string `json:"timezone"`
	MaxSeats      int    `json:"maxSeats"`
	ShowRemaining bool   `json:"showRemaining"`
}

// closedFormResponse — тело GET /public/v1/forms/{slug} для ЗАКРЫТОЙ формы (HTTP
// 410 Gone). Схемы и токена нет — принимать ответ нельзя; рендерер по 410 рисует
// экран «приём закрыт» из этих полей. closedMessage уже разрезолвлен (свой/дефолт).
type closedFormResponse struct {
	Closed bool `json:"closed"`
	// Title — что написать заголовком: свой заголовок автора (0043), а если его нет
	// — название формы. Разрешает СЕРВЕР, чтобы у рендерера не было двух источников
	// одного заголовка и ветки «какой из них сейчас».
	Title         string `json:"title"`
	ClosedMessage string `json:"closedMessage"`
	// Бейдж стоит и на этом экране: иначе он снимается разглядыванием второго
	// экрана — открыл закрытую форму, и бренда нет.
	ShowBadge bool `json:"showBadge"`
}

// lockedFormResponse — тело GET /public/v1/forms/{slug} для формы под паролем (HTTP
// 401 form_locked). Схемы и токена здесь нет — до пароля рендереру их видеть нечем.
type lockedFormResponse struct {
	Locked bool `json:"locked"`
	// Title — название формы: экран ввода пароля его ПОКАЗЫВАЕТ (решение владельца
	// 2026-09-01, design/form-password.md §2.3). Пароль прячет вопросы и ответы, а не
	// факт существования формы; <title> вкладки и OG-карточка остаются как были.
	Title string `json:"title"`
	// Бейдж стоит и на этом экране — по тому же доводу, что на экране «приём закрыт»:
	// иначе он снимается разглядыванием второго экрана.
	ShowBadge bool `json:"showBadge"`
}

// unlockRequest/unlockResponse — тело POST /public/v1/forms/{slug}/unlock.
type unlockRequest struct {
	Password string `json:"password"`
}

type unlockResponse struct {
	Token string `json:"token"`
	// ExpiresIn — сколько секунд токен ещё годен. Рендереру он нужен, чтобы не
	// предъявлять заведомо просроченный и не показывать из-за этого отказ вместо
	// экрана пароля.
	ExpiresIn int `json:"expiresIn"`
}

// maxUnlockBodyBytes — потолок тела заявки на разблокировку (инвариант 3). В нём
// только пароль, чей потолок — 128 рун.
const maxUnlockBodyBytes = 4 << 10

// unlock сверяет пароль и выдаёт токен разблокировки.
//
// ЛИМИТ СПИСЫВАЕТСЯ ДО СВЕРКИ и по паре «IP + slug». До сверки — потому что иначе
// верный пароль обходил бы исчерпанное ведро, и подбор стоил бы ровно столько же:
// угадал — прошёл. По паре — потому что ведро по одному адресу закрывало бы
// подбираемой формой все остальные, а по одному slug один подбирающий закрывал бы
// форму всем её участникам.
func (h *PublicHandler) unlock(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	slug := r.PathValue("slug")
	// Slug нашей формы — nanoid фиксированной длины (domain.SlugLen). Чужая длина не
	// может принадлежать ни одной форме, поэтому отвечаем 404, как несуществующей, и
	// НЕ заводим под неё ведро: длину сегмента адреса ограничивает только заголовок
	// запроса, и ключ лимитера иначе растёт вместе с ним.
	if len(slug) != domain.SlugLen {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	key := httpserver.ClientIP(r, h.trustedProxy) + "|" + slug
	if !h.unlockLimiter.Allow(key) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много попыток, подождите минуту", domain.ErrRateLimited))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUnlockBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req unlockRequest
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxUnlockBodyBytes))
			return
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	tok, expiry, err := h.svc.Unlock(r.Context(), slug, req.Password)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, unlockResponse{
		Token:     tok,
		ExpiresIn: int(time.Until(expiry).Seconds()),
	})
}

// formTokenResponse — тело GET /public/v1/form-token.
type formTokenResponse struct {
	Token string `json:"token"`
}

// formToken выдаёт подписанное время выдачи — тот самый токен, чей возраст проверяют
// приём ответа, выдача слота файла и бикон визита.
//
// Ручка НЕ знает про форму и не ходит в базу: токен есть HMAC над временем, он не
// привязан к слагу (граница известна — TECH-DEBT §5), а обязательный slug стоил бы
// запроса в базу на каждое открытие формы ровно ради подписи времени.
//
// МИНА: ответ обязан быть некэшируемым. Токен жил в теле GET /forms/{slug} с
// max-age=60 и иммутабельным ETag, и из-за этого окно [minFillTime, MaxAge] мерило
// возраст записи в кэше браузера, а не человека: первое открытие формы всегда
// упиралось в отказ, а дальше 304 бессрочно возвращал первый токен. История —
// JOURNAL, «Токен формы выдаётся некэшируемым ответом».
func (h *PublicHandler) formToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusOK, formTokenResponse{
		Token: token.Issue(h.tokenSecret, h.now().UTC()),
	})
}

func (h *PublicHandler) get(w http.ResponseWriter, r *http.Request) {
	pf, err := h.svc.PublicForm(r.Context(), r.PathValue("slug"))
	if err != nil {
		// ErrNotFound → 404 для черновика/несуществующей (приватное не раскрывается).
		httpserver.WriteError(w, r, err)
		return
	}

	// Пароль — ПЕРВЫЙ барьер, раньше проверки закрытости: под паролем прячется всё
	// содержимое формы, включая текст экрана «приём закрыт», который тоже написал
	// автор. Кэш выключаем на весь путь формы с паролем — и на отказе, и после
	// разблокировки: публичный max-age у тела с вопросами означал бы, что общий
	// прокси раздаёт его кому угодно.
	if len(pf.PasswordSealed) > 0 {
		w.Header().Set("Cache-Control", "no-store")
		if err := h.svc.VerifyUnlock(pf.FormID, pf.PasswordSealed, r.Header.Get(UnlockHeader)); err != nil {
			httpserver.WriteJSON(w, r, http.StatusUnauthorized, lockedFormResponse{
				Locked:    true,
				Title:     titleOrFallback(pf.Title),
				ShowBadge: h.showBadge(r, pf.WorkspaceID, pf.Branding),
			})
			return
		}
	}

	// Форма была публичной, но больше не принимает ответы (снята/дата/лимит) → 410
	// «приём закрыт» вместо 404 (решение владельца, шаг 4). Кэш выключаем: закрытость
	// живая (продление даты, удаление ответа могут переоткрыть форму).
	if domain.FormClosed(pf.Status, pf.CloseAt, pf.ResponseLimit, pf.SubmissionCount, h.now().UTC()) {
		w.Header().Set("Cache-Control", "no-store")
		httpserver.WriteJSON(w, r, http.StatusGone, closedFormResponse{
			Closed: true,
			// Намерение о бейдже — живая колонка формы, поэтому разбирать снапшот
			// на этой ветке (форма закрыта, схемы в ответе нет) больше не нужно.
			ShowBadge: h.showBadge(r, pf.WorkspaceID, pf.Branding),
			// Экран «приём закрыт» — единственное место рендерера, где заголовок
			// показывается БЕЗ схемы (её в 410 нет вовсе), поэтому пустоту здесь
			// замещаем так же, как в <title> вкладки.
			Title:         closedTitle(pf),
			ClosedMessage: closedMessageOrDefault(pf.ClosedMessage),
		})
		return
	}

	// ETag = id опубликованной версии: иммутабелен, меняется только при новой
	// публикации. Кэш 60 с — терпимо для формы (правки видны после переиздания).
	//
	// ПЛЮС СОСТОЯНИЕ БЕЙДЖА: оно не часть версии, а часть ПРЕДСТАВЛЕНИЯ, и меняется
	// от тумблера автора и от смены тарифа, а не от переиздания. Без него автор,
	// снявший бейдж (или подписавшийся), получал бы на каждый повторный запрос 304 с
	// прежним телом — то есть бейдж оставался бы у всех, кто уже открывал форму,
	// пока не сменится версия.
	showBadge := h.showBadge(r, pf.WorkspaceID, pf.Branding)
	// Форма под паролем кэша не получает ВОВСЕ — ни публичного, ни ETag'а: no-store
	// поставлен выше, и перебивать его здесь нельзя. Публичный max-age у тела с
	// вопросами означал бы, что общий прокси раздаёт содержимое закрытой формы
	// кому угодно, а сама выдача зависит от заголовка запроса, которого нет в ключе
	// кэша. Минута кэша разблокированной формы того не стоит.
	if len(pf.PasswordSealed) == 0 {
		etag := `"` + pf.VersionID.String() + viewETagSuffix(showBadge, pf.Progress, pf.AutoJump, pf.SaveLocally, pf.AllowBack) + `"`
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.Header().Set("ETag", etag)
		if etagMatches(r.Header.Get("If-None-Match"), etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}

	// Рендерер знает только текущий формат — старая опубликованная версия
	// апгрейдится до v4 на отдаче (иммутабельный снапшот в БД не трогаем). Разбор
	// стоит ПОСЛЕ ветки 304: это самая дорогая операция пути (документ формы
	// целиком), и повторному запросу с тем же ETag она не нужна вовсе.
	//
	// Разбор приезжает из сервиса (pf.Parsed): он всё равно разбирает документ,
	// разрешая заголовок, и второй разбор тех же байтов здесь был чистой потерей.
	// Довод «правка контракта ради микросекунд», которым этот разбор когда-то был
	// оставлен, считал один путь — отдачу тела; путей же шесть, и на четырёх из них
	// вызовов на респондента десятки (TD-77, закрыт).
	if pf.ParseErr != nil {
		httpserver.WriteError(w, r, fmt.Errorf("canonical public schema %s: %w", r.PathValue("slug"), pf.ParseErr))
		return
	}
	schema, err := json.Marshal(pf.Parsed)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("marshal public schema %s: %w", r.PathValue("slug"), err))
		return
	}

	httpserver.WriteJSON(w, r, http.StatusOK, publicFormResponse{
		Title:          pf.Title,
		Version:        pf.Version,
		Schema:         schema,
		ShowBadge:      showBadge,
		CollectPartial: h.collectPartial(r, pf.WorkspaceID, pf.CollectPartial),
		Progress:       pf.Progress,
		AutoJump:       pf.AutoJump,
		SaveLocally:    pf.SaveLocally,
		AllowBack:      pf.AllowBack,
		Booking:        h.bookingFacts(r, pf.ScheduleID),
	})
}

// bookingFacts — факты расписания формы для рендерера. nil, если записи нет.
//
// Сбой опроса расписания живого выбора НЕ включает: вопрос о времени тогда рисуется
// плашкой, а форма остаётся отправляемой. Обратный выбор (показать пикер и не дать ему
// данных) означал бы вопрос, который нельзя ни заполнить, ни пропустить.
func (h *PublicHandler) bookingFacts(r *http.Request, scheduleID *uuid.UUID) *bookingFacts {
	if scheduleID == nil || h.booking == nil {
		return nil
	}
	f, err := h.booking.FactsFor(r.Context(), scheduleID)
	if err != nil || f == nil {
		if err != nil {
			httpserver.LoggerFrom(r.Context()).Warn("schedule facts not read, booking hidden",
				slog.String("schedule_id", scheduleID.String()), slog.String("error", err.Error()))
		}
		return nil
	}
	return &bookingFacts{Timezone: f.Timezone, MaxSeats: f.MaxSeats, ShowRemaining: f.ShowRemaining}
}

// collectPartial — решение «собирать ли черновики» для этой выдачи. Сбой опроса
// тарифа сбор НЕ начинает: невзятый черновик дешевле, чем взятый без права
// (у бейджа выбор обратный — там при сбое остаётся бренд).
func (h *PublicHandler) collectPartial(r *http.Request, workspaceID uuid.UUID, intent bool) bool {
	on, err := h.svc.CollectPartial(r.Context(), workspaceID, intent)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("collect partial gate",
			slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
		return false
	}
	return on
}

// closedTitle — заголовок экрана «приём закрыт»: свой заголовок автора, иначе
// название формы (иначе — общий фолбэк, как в <title> вкладки: у формы без названия
// заголовка нет вовсе).
func closedTitle(pf PublicForm) string {
	if pf.ClosedTitle != nil && *pf.ClosedTitle != "" {
		return *pf.ClosedTitle
	}
	return titleOrFallback(pf.Title)
}

// showBadge — решение «рисовать ли бейдж» для этой выдачи. Сбой опроса тарифа не
// имеет права уронить публичную форму: бейдж остаётся, причина уходит в лог с
// request_id (лишний бейдж у платящего дешевле, чем пятисотка респонденту).
func (h *PublicHandler) showBadge(r *http.Request, workspaceID uuid.UUID, intent bool) bool {
	show, err := h.svc.ShowBadge(r.Context(), workspaceID, intent)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("проверка тарифа для бейджа",
			slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
	}
	return show
}

// viewETagSuffix — метка ПРЕДСТАВЛЕНИЯ в ETag: всё, что меняет тело ответа, не меняя
// опубликованной версии. Сегодня это бейдж (тумблер автора плюс тариф) и шкала
// прогресса (тумблер автора). Отдельной функцией, а не тернарником по месту: суффикс
// участвует в сравнении с If-None-Match, и обе стороны обязаны считать его одинаково.
//
// МИНА: забытый здесь признак означает 304 с прежним телом до самой перепубликации —
// автор переключил тумблер, а все, кто форму уже открывал, видят старое.
func viewETagSuffix(showBadge, progress, autoJump, saveLocally, allowBack bool) string {
	suffix := ""
	if showBadge {
		suffix += "+b"
	}
	if progress {
		suffix += "+p"
	}
	if autoJump {
		suffix += "+j"
	}
	if saveLocally {
		suffix += "+s"
	}
	if allowBack {
		suffix += "+k"
	}
	return suffix
}

// closedMessageOrDefault — свой текст владельца, если задан, иначе дефолт.
func closedMessageOrDefault(msg *string) string {
	if msg != nil {
		if trimmed := strings.TrimSpace(*msg); trimmed != "" {
			return trimmed
		}
	}
	return defaultClosedMessage
}

// etagMatches сверяет заголовок If-None-Match с текущим ETag (список через запятую
// либо "*"). Достаточно для нашего сильного валидатора; W/ слабых тегов мы не выдаём.
func etagMatches(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	if strings.TrimSpace(ifNoneMatch) == "*" {
		return true
	}
	for _, part := range strings.Split(ifNoneMatch, ",") {
		if strings.TrimSpace(part) == etag {
			return true
		}
	}
	return false
}
