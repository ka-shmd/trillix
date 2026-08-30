package submissions

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/printer"
)

// Middleware — HTTP-обёртка (RequireAuth из auth), инжектируемая в composition root:
// submissions не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// listService — часть сервиса, нужная приватному транспорту (листинг + экспорт +
// сводка + удаление).
type listService interface {
	ListForForm(ctx context.Context, userID, formID uuid.UUID, after *Cursor, limit int) (Page, error)
	ListFeedForForm(ctx context.Context, userID, formID uuid.UUID, after *TimeCursor, limit int) (FeedPage, error)
	ExportCSV(ctx context.Context, userID, formID uuid.UUID, emit func(record []string) error) error
	Summary(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (domain.Summary, error)
	BlockAnswers(ctx context.Context, userID, formID uuid.UUID, blockID string, period domain.Period, after *Cursor, limit int) (AnswerPage, error)
	CountInPeriod(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (int, error)
	DeleteForForm(ctx context.Context, userID, formID, submissionID uuid.UUID) error
	AuthorizePrint(ctx context.Context, userID, formID, submissionID uuid.UUID) (PrintAccess, error)
	ListPartialsForForm(ctx context.Context, userID, formID uuid.UUID, after *TimeCursor, limit int) (PartialPage, error)
	DeletePartialForForm(ctx context.Context, userID, formID, visitID uuid.UUID) error
}

// utf8BOM — метка порядка байтов: Excel без неё принимает UTF-8 CSV за ANSI и
// ломает кириллицу. Пишется первой, до заголовка таблицы.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// csvFlushEvery — как часто сбрасывать буфер csv.Writer в сеть: ответ начинает
// течь клиенту, не дожидаясь всей выборки.
const csvFlushEvery = 500

// exportWriteChunkTimeout — потолок времени на отправку одного чанка экспорта.
// Дедлайн записи продлевается на каждом флаше (см. export), поэтому длинный, но
// прогрессирующий трансфер не рвётся, а полностью зависший клиент отваливается
// через этот таймаут. Переопределяет общий WriteTimeout сервера (10 с) для этого
// стрима — иначе большой экспорт на медленном канале обрубается на середине (TD-4).
const exportWriteChunkTimeout = 30 * time.Second

// Handler — приватный транспорт модуля submissions: автор смотрит, печатает и
// удаляет ответы своей формы. Чтение (GET) — за RequireAuth; удаление (DELETE) —
// ещё и за RequireCSRF.
type Handler struct {
	svc         listService
	requireAuth Middleware
	requireCSRF Middleware
	// printer — сервис печати PDF; nil означает «печати на этом контуре нет» (в dev
	// контейнера принтера не существует). Ручка тогда отвечает 503 со словами, а не
	// молчит и не притворяется, что документа нет.
	printer PrintClient
	// printSecret — секрет токенов печати, выведенный из секрета контура
	// (printtoken.go). Пуст, когда печати нет.
	printSecret []byte
	now         func() time.Time
}

// PrintClient — потребляемый интерфейс сервиса печати (реализация — *printer.Client).
// Путь, а не адрес: origin знает сам принтер, поэтому попросить его сходить на чужой
// хост нельзя.
type PrintClient interface {
	PDF(ctx context.Context, path string) ([]byte, error)
}

func NewHandler(svc listService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF, now: time.Now}
}

// WithPrinter подключает печать. Отдельным сеттером, а не аргументом конструктора:
// печать есть не на каждом контуре, и у конструктора уже три аргумента, из которых
// два — обёртки-мидлвари.
func (h *Handler) WithPrinter(client PrintClient, formTokenSecret []byte) *Handler {
	h.printer = client
	h.printSecret = derivePrintSecret(formTokenSecret)
	return h
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms/{id}/submissions", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("GET /api/v1/forms/{id}/submissions/export", h.requireAuth(http.HandlerFunc(h.export)))
	mux.Handle("GET /api/v1/forms/{id}/submissions/summary", h.requireAuth(http.HandlerFunc(h.summary)))
	// Значения одного вопроса: подпуть сводки, а не свой корень — окно открывается
	// из её строки и живёт по тем же правилам (то же окно наблюдения, тот же рендер).
	mux.Handle("GET /api/v1/forms/{id}/submissions/summary/{block}", h.requireAuth(http.HandlerFunc(h.blockAnswers)))
	mux.Handle("GET /api/v1/forms/{id}/submissions/count", h.requireAuth(http.HandlerFunc(h.count)))
	// Печать — СВОЙ корень, а не подпуть /submissions/{sid}: рядом живёт
	// /submissions/summary/{block}, и «{sid}/pdf» с ним неразличим для маршрутизатора
	// (оба матчат .../submissions/summary/pdf). Тот же приём, что у черновиков,
	// которые тоже вынесены из-под /submissions.
	mux.Handle("GET /api/v1/forms/{id}/print/{sid}", h.requireAuth(http.HandlerFunc(h.pdf)))
	mux.Handle("DELETE /api/v1/forms/{id}/submissions/{sid}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
	// Черновики — СВОЙ корень, а не подпуть /submissions: это другая таблица, другой
	// курсор и другое право (гейт тарифа). Вкладка кабинета соседняя, данные — нет.
	mux.Handle("GET /api/v1/forms/{id}/partials", h.requireAuth(http.HandlerFunc(h.listPartials)))
	mux.Handle("DELETE /api/v1/forms/{id}/partials/{vid}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.deletePartial))))
}

// --- DTO ---

// submissionResponse — одна строка раздела «Ответы». Kind различает отправленный
// ответ и незавершённый: вкладка «Все ответы» отдаёт оба вида, «Законченные» —
// только первый, а разметка таблицы, окно строки и удаление у них общие.
//
// UpdatedAt и LastBlockID есть ТОЛЬКО у черновика (omitempty): у отправленного
// ответа не было ни правок после отправки, ни места, где человек остановился.
type submissionResponse struct {
	Kind        string          `json:"kind"`
	ID          string          `json:"id"`
	FormVersion int32           `json:"formVersion"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   *time.Time      `json:"updatedAt,omitempty"`
	LastBlockID string          `json:"lastBlockId,omitempty"`
	Answers     json.RawMessage `json:"answers"`
}

type listResponse struct {
	Submissions []submissionResponse `json:"submissions"`
	NextCursor  *string              `json:"nextCursor"`
	Total       int64                `json:"total"`
	// Hidden — сколько ответов скрыто квотой тарифа (0014). Ноль у всех, кто в
	// лимит укладывается. Кабинет рисует по нему плашку со словами «сохранены и
	// откроются после перехода на Pro»: спрятать данные молча нельзя.
	Hidden int64 `json:"hidden"`
	// Files — метаданные приложенных файлов страницы, upload_id → имя и размер
	// (фаза 24). Отдельной картой, а не внутри answers: в самом ответе лежат
	// только id, и подмешивать имя в значение значило бы держать его в двух
	// местах, из которых одно пришло от клиента. Скачивание — GET /files/{id},
	// ссылки здесь нет намеренно: подпись живёт минуту и в списке протухла бы
	// раньше, чем автор до неё доскроллит.
	Files map[string]fileResponse `json:"files,omitempty"`
}

type fileResponse struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// list отдаёт страницу раздела «Ответы». ?kind=all — оба множества одним списком по
// времени (вкладка «Все ответы»), иначе только отправленные («Законченные»).
//
// Курсор у двух видов РАЗНЫЙ (одноколоночный по id против составного), и это
// намеренно скрыто за одной непрозрачной строкой: клиент курсор не разбирает, а
// парсер выбирается тем же kind, что и выборка. Курсор чужого вида → 422, как
// любой битый.
func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("kind") == "all" {
		h.listFeed(w, r)
		return
	}
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	after, ok := parseCursor(w, r)
	if !ok {
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))

	page, err := h.svc.ListForForm(r.Context(), userID, formID, after, limit)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	items := make([]submissionResponse, len(page.Submissions))
	for i, s := range page.Submissions {
		items[i] = submissionResponse{
			Kind:        feedKindSubmission,
			ID:          s.ID.String(),
			FormVersion: s.FormVersion,
			CreatedAt:   s.CreatedAt,
			Answers:     s.Answers,
		}
	}
	resp := listResponse{Submissions: items, Total: page.Total, Hidden: page.Hidden}
	if len(page.Files) > 0 {
		resp.Files = make(map[string]fileResponse, len(page.Files))
		for id, f := range page.Files {
			resp.Files[id] = fileResponse{Name: f.Name, Size: f.Size}
		}
	}
	if page.NextCursor != nil {
		enc := encodeCursor(*page.NextCursor)
		resp.NextCursor = &enc
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// listFeed — вкладка «Все ответы»: отправленные и незавершённые одним списком.
func (h *Handler) listFeed(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	after, ok := parseTimeCursor(w, r)
	if !ok {
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))

	page, err := h.svc.ListFeedForForm(r.Context(), userID, formID, after, limit)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	items := make([]submissionResponse, len(page.Rows))
	for i, row := range page.Rows {
		item := submissionResponse{
			Kind:        row.Kind,
			ID:          row.ID.String(),
			FormVersion: row.FormVersion,
			CreatedAt:   row.CreatedAt,
			Answers:     row.Answers,
		}
		if row.Kind == feedKindPartial {
			at := row.At
			item.UpdatedAt = &at
			item.LastBlockID = row.LastBlockID
		}
		items[i] = item
	}
	resp := listResponse{Submissions: items, Total: page.Total, Hidden: page.Hidden}
	if len(page.Files) > 0 {
		resp.Files = make(map[string]fileResponse, len(page.Files))
		for id, f := range page.Files {
			resp.Files[id] = fileResponse{Name: f.Name, Size: f.Size}
		}
	}
	if page.NextCursor != nil {
		enc := encodeTimeCursor(*page.NextCursor)
		resp.NextCursor = &enc
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// partialResponse — один черновик в проекции кабинета. id строки — id ВИЗИТА
// (черновик принадлежит визиту, а не себе), поэтому поле называется visitId: имя
// «id» скрыло бы, что удаление и обновление адресуются визитом.
//
// updatedAt и createdAt оба: таблица показывает последнюю правку (черновик
// меняется, пока человек печатает), а окно — ещё и когда он начал.
type partialResponse struct {
	VisitID     string    `json:"visitId"`
	FormVersion int32     `json:"formVersion"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	// LastBlockID — вопрос, на котором человек остановился; пустая строка, если
	// рендерер его не прислал (старая вкладка, ответ стёрт).
	LastBlockID string          `json:"lastBlockId"`
	Answers     json.RawMessage `json:"answers"`
}

type partialsResponse struct {
	Partials   []partialResponse `json:"partials"`
	NextCursor *string           `json:"nextCursor"`
	Total      int64             `json:"total"`
}

// listPartials отдаёт страницу черновиков формы. Гейт тарифа — в сервисе, сюда он
// приходит как domain.ErrPlanRequired (402 plan_required): кабинет рисует по нему
// плашку, а не коробку ошибки.
func (h *Handler) listPartials(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	after, ok := parseTimeCursor(w, r)
	if !ok {
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))

	page, err := h.svc.ListPartialsForForm(r.Context(), userID, formID, after, limit)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	items := make([]partialResponse, len(page.Partials))
	for i, p := range page.Partials {
		items[i] = partialResponse{
			VisitID:     p.VisitID.String(),
			FormVersion: p.FormVersion,
			CreatedAt:   p.CreatedAt,
			UpdatedAt:   p.UpdatedAt,
			LastBlockID: p.LastBlockID,
			Answers:     p.Answers,
		}
	}
	resp := partialsResponse{Partials: items, Total: page.Total}
	if page.NextCursor != nil {
		enc := encodeTimeCursor(*page.NextCursor)
		resp.NextCursor = &enc
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// deletePartial убирает один черновик. 204 без тела — как удаление ответа.
func (h *Handler) deletePartial(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	visitID, err := uuid.Parse(r.PathValue("vid"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	if err := h.svc.DeletePartialForForm(r.Context(), userID, formID, visitID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Сводка. kind — по нему фронт выбирает вид: distribution → buckets, number →
// number, fill → только asked/answered. buckets/number приходят лишь там, где
// осмысленны (omitempty), Zod-схема кабинета это допускает.
type summaryBucketResponse struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

type numberStatsResponse struct {
	Avg float64 `json:"avg"`
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// answerSampleResponse — одно показанное значение ответа. Наружу уходит текст, уже
// готовый к показу (подписи опций вместо id), и время — экран рисует «2 минуты назад».
type answerSampleResponse struct {
	Text string `json:"text"`
	At   string `json:"at"`
}

type blockSummaryResponse struct {
	BlockID  string                  `json:"blockId"`
	Label    string                  `json:"label"`
	Type     string                  `json:"type"`
	Kind     string                  `json:"kind"`
	Asked    int                     `json:"asked"`
	Answered int                     `json:"answered"`
	Buckets  []summaryBucketResponse `json:"buckets,omitempty"`
	Number   *numberStatsResponse    `json:"number,omitempty"`
	// Samples — до domain.SamplesLimit последних значений, новыми сверху. Потолок
	// часть контракта: аналитическая ручка отдаёт счётчики и небольшую выборку, всё
	// остальное — через листинг ответов со своей пагинацией (ADR §10).
	Samples []answerSampleResponse `json:"samples,omitempty"`
}

type summaryResponse struct {
	Total  int                    `json:"total"`
	Blocks []blockSummaryResponse `json:"blocks"`
}

// summary отдаёт агрегат по ответам формы: наружу уходят только счётчики, сырые
// ответы браузер не получает.
//
// Логирует строку «сколько ответов свернули и за сколько». Длительность запроса пишет
// и общий middleware, но без знаменателя она бесполезна: 900 мс на 300 ответах и на
// 30 000 — разные новости. Это третий слой наблюдаемости из ARCHITECTURE §«Мониторинг»
// (счётчики в лог, а не Prometheus на одном VPS); содержимое ответов в лог не идёт.
func (h *Handler) summary(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}

	period, err := httpserver.PeriodFromRequest(r)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	start := time.Now()
	sum, err := h.svc.Summary(r.Context(), userID, formID, period)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.LoggerFrom(r.Context()).Info("submissions summary",
		slog.String("form_id", formID.String()),
		slog.Int("submissions", sum.Total),
		slog.Int("questions", len(sum.Blocks)),
		slog.Duration("duration", time.Since(start)),
	)

	blocks := make([]blockSummaryResponse, len(sum.Blocks))
	for i, b := range sum.Blocks {
		item := blockSummaryResponse{
			BlockID:  b.BlockID,
			Label:    b.Label,
			Type:     string(b.Type),
			Kind:     string(b.Kind),
			Asked:    b.Asked,
			Answered: b.Answered,
		}
		if len(b.Buckets) > 0 {
			item.Buckets = make([]summaryBucketResponse, len(b.Buckets))
			for j, bk := range b.Buckets {
				item.Buckets[j] = summaryBucketResponse{Key: bk.Key, Label: bk.Label, Count: bk.Count}
			}
		}
		if b.Number != nil {
			item.Number = &numberStatsResponse{Avg: b.Number.Avg, Min: b.Number.Min, Max: b.Number.Max}
		}
		if len(b.Samples) > 0 {
			item.Samples = make([]answerSampleResponse, len(b.Samples))
			for j, sm := range b.Samples {
				item.Samples[j] = answerSampleResponse{
					Text: sm.Text,
					At:   sm.At.UTC().Format(time.RFC3339),
				}
			}
		}
		blocks[i] = item
	}
	httpserver.WriteJSON(w, r, http.StatusOK, summaryResponse{Total: sum.Total, Blocks: blocks})
}

type answerResponse struct {
	Text string    `json:"text"`
	At   time.Time `json:"at"`
}

type blockAnswersResponse struct {
	Answers    []answerResponse `json:"answers"`
	NextCursor *string          `json:"nextCursor"`
}

// blockAnswers — все значения ОДНОГО вопроса страницами: окно «все ответы» на
// вкладке «Сводка». Сводка отдаёт по десять последних на каждый вопрос, здесь тот
// же вопрос листается целиком.
//
// Наружу уходит готовый ТЕКСТ значения, как и в сводке: подпись выбранной опции, а
// не её id. Разбор на клиенте был бы третьей копией доменных правил после Go и Zod.
func (h *Handler) blockAnswers(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	after, ok := parseCursor(w, r)
	if !ok {
		return
	}
	period, err := httpserver.PeriodFromRequest(r)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Окно наблюдения то же, что у сводки, и это несущее: открыв «все ответы» из
	// строки «Ответили 12 из 34» за неделю, владелец обязан увидеть те же двенадцать.
	page, err := h.svc.BlockAnswers(r.Context(), userID, formID, r.PathValue("block"), period,
		after, parseLimit(r.URL.Query().Get("limit")))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	items := make([]answerResponse, len(page.Answers))
	for i, a := range page.Answers {
		items[i] = answerResponse{Text: a.Text, At: a.At}
	}
	resp := blockAnswersResponse{Answers: items}
	if page.NextCursor != nil {
		enc := encodeCursor(*page.NextCursor)
		resp.NextCursor = &enc
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// countResponse — карточка «Ответы» над вкладками Insights.
type countResponse struct {
	Submissions int `json:"submissions"`
}

// count отдаёт число ответов за период. Отдельная ручка, а не поле в счётчиках
// визитов: это второе независимое множество (ANALYTICS.md §1) и чужой модуль, а
// сведение их в один ответ рано или поздно кончилось бы делением одного на другое.
// Запрос дешёвый — count по индексу (form_id, over_quota).
func (h *Handler) count(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	period, err := httpserver.PeriodFromRequest(r)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	n, err := h.svc.CountInPeriod(r.Context(), userID, formID, period)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, countResponse{Submissions: n})
}

// export стримит все ответы формы в CSV (браузерное скачивание, cookie авторизует).
// Заголовки и статус 200 пишутся ЛЕНИВО — на первой строке (заголовке таблицы):
// пока не пошёл body, ошибка авторизации из сервиса (чужая/нет формы) ещё может
// стать 404 через WriteError. После начала стрима статус не поменять — ошибку
// (обрыв записи, отмена ctx) только логируем на самом верху.
func (h *Handler) export(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}

	// rc продлевает write-дедлайн соединения между чанками: общий WriteTimeout
	// сервера (10 с) обрубил бы длинный экспорт, а тут дедлайн обновляется на каждом
	// флаше (TD-4). Доходит до соединения через statusWriter.Unwrap.
	rc := http.NewResponseController(w)
	deadlineErrLogged := false
	extendWriteDeadline := func() {
		if err := rc.SetWriteDeadline(time.Now().Add(exportWriteChunkTimeout)); err != nil && !deadlineErrLogged {
			deadlineErrLogged = true
			httpserver.LoggerFrom(r.Context()).Warn("csv export: cannot extend write deadline",
				slog.String("form_id", formID.String()), slog.String("error", err.Error()))
		}
	}

	var (
		cw      *csv.Writer
		started bool
		written int
	)
	emit := func(record []string) error {
		if !started {
			started = true
			extendWriteDeadline()
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", csvContentDisposition(formID))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(utf8BOM)
			cw = csv.NewWriter(w)
		}
		if err := cw.Write(record); err != nil {
			return err
		}
		if written++; written%csvFlushEvery == 0 {
			cw.Flush()
			if err := cw.Error(); err != nil {
				return err
			}
			extendWriteDeadline()
		}
		return nil
	}

	err := h.svc.ExportCSV(r.Context(), userID, formID, emit)
	if !started {
		// Тело ещё не начато → ошибка маппится на статус (404/…). Сюда попадаем только
		// при ошибке авторизации: успешный экспорт всегда эмитит заголовок таблицы.
		httpserver.WriteError(w, r, err)
		return
	}
	cw.Flush()
	if err == nil {
		err = cw.Error()
	}
	if err != nil {
		// Стрим уже начат (200 отправлен) — статус не изменить. Логируем на самом верху.
		httpserver.LoggerFrom(r.Context()).Error("csv export interrupted",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
	}
}

// csvContentDisposition — имя скачиваемого файла. ASCII-фолбэк + RFC 5987 filename*
// (на случай нелатинских частей в будущем); сейчас имя из id формы — уже ASCII.
func csvContentDisposition(formID uuid.UUID) string {
	name := "submissions-" + formID.String() + ".csv"
	return fmt.Sprintf("attachment; filename=%q", name)
}

// pdfPrintTimeout — потолок на всю печать: ожидание слота у принтера плюс работа
// браузера. Дольше держать соединение бессмысленно — автор к этому времени уже
// нажал кнопку второй раз.
const pdfPrintTimeout = 25 * time.Second

// pdfRetryAfter — что сказать автору, когда все слоты печати заняты. Секунды: печать
// одного документа идёт единицы секунд, и повтор через десять почти наверняка
// попадёт в свободный слот.
const pdfRetryAfter = "10"

// pdf печатает один ответ формы в PDF и отдаёт файл браузеру.
//
// Порядок принципиален: сначала право (AuthorizePrint — чужая форма или удалённый
// ответ дают 404 ДО того, как поднимется браузер), потом токен печати, потом сама
// печать. Синхронно: документ готовится секунды, а очередь, письмо и «ваш файл
// готов» стоили бы больше, чем экономили (ARCHITECTURE §4.4).
func (h *Handler) pdf(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	subID, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}

	access, err := h.svc.AuthorizePrint(r.Context(), userID, formID, subID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	// Печать может быть не настроена на контуре (dev): это не ошибка автора и не
	// отсутствие ответа, поэтому 503 и человеческий текст, а не 404 или 500.
	if h.printer == nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: печать PDF на этом контуре не настроена", domain.ErrUnavailable))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), pdfPrintTimeout)
	defer cancel()

	token := issuePrintToken(h.printSecret, formID, subID, h.now().Add(printTokenTTL))
	// Дедлайн записи продлевается по образцу экспорта CSV: общий WriteTimeout
	// сервера (10 с) короче, чем печать вправе идти, и без продления соединение
	// рвалось бы на середине документа (TD-4).
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Now().Add(pdfPrintTimeout + 5*time.Second)); err != nil {
		httpserver.LoggerFrom(r.Context()).Warn("pdf: cannot extend write deadline",
			slog.String("error", err.Error()))
	}

	doc, err := h.printer.PDF(ctx, "/internal/print/doc/"+token)
	if err != nil {
		switch {
		case errors.Is(err, printer.ErrBusy):
			w.Header().Set("Retry-After", pdfRetryAfter)
			httpserver.WriteError(w, r, fmt.Errorf("%w: печать занята, попробуйте ещё раз", domain.ErrUnavailable))
		case errors.Is(err, printer.ErrUnreachable):
			// Связь с соседним сервисом, а не поломка кода: 503, а причина — в лог,
			// потому что чинит её оператор контура, а не человек у экрана.
			httpserver.LoggerFrom(r.Context()).Error("printer unreachable",
				slog.String("error", err.Error()))
			httpserver.WriteError(w, r, fmt.Errorf("%w: сервис печати недоступен", domain.ErrUnavailable))
		default:
			httpserver.WriteError(w, r, fmt.Errorf("print submission %s: %w", subID, err))
		}
		return
	}

	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", pdfContentDisposition(access))
	w.Header().Set("Content-Length", strconv.Itoa(len(doc)))
	if _, err := w.Write(doc); err != nil {
		httpserver.LoggerFrom(r.Context()).Warn("pdf write failed", slog.String("error", err.Error()))
	}
}

// pdfContentDisposition — имя скачиваемого файла: «<форма> — <дата>.pdf». ASCII-имя
// в filename остаётся техническим (кириллица в нём ломается у старых клиентов),
// человеческое едет в filename* по RFC 5987 — так автор находит нужный файл в папке
// «Загрузки» через полгода, а не разбирает там десяток submission-<uuid>.pdf.
func pdfContentDisposition(a PrintAccess) string {
	date := a.CreatedAt.UTC().Format("2006-01-02")
	human := strings.TrimSpace(a.FormTitle)
	if human == "" {
		human = "Ответ"
	}
	human += " — " + date + ".pdf"
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s",
		"submission-"+date+".pdf", url.PathEscape(human))
}

// delete удаляет один ответ формы (GDPR-гигиена). За RequireAuth+RequireCSRF.
func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	subID, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		// Неразбираемый id → 404 (несуществующий ответ), без раскрытия чего-либо.
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	if err := h.svc.DeleteForForm(r.Context(), userID, formID, subID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Разбор запроса ---

// currentUserID достаёт пользователя, положенного RequireAuth. Отсутствие — 401
// (защита от неверной сборки цепочки middleware).
func currentUserID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return uuid.Nil, false
	}
	return u.ID, true
}

// parseFormID разбирает {id}; неразбираемый uuid → 404 (несуществующая форма,
// без раскрытия чего-либо), а не 400.
func parseFormID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return uuid.Nil, false
	}
	return id, true
}

func parseLimit(raw string) int {
	if raw == "" {
		return 0 // сервис подставит DefaultPageLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return n
}

// parseCursor разбирает непрозрачный ?cursor. Отсутствует → первая страница;
// присутствует, но битый → 422 (клиент передал испорченный курсор).
func parseCursor(w http.ResponseWriter, r *http.Request) (*Cursor, bool) {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return nil, true
	}
	c, err := decodeCursor(raw)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный курсор", domain.ErrValidation))
		return nil, false
	}
	return c, true
}

// Курсор ответов — одна колонка (id): кодируем uuid в непрозрачную base64url-строку.
func encodeCursor(c Cursor) string {
	return base64.RawURLEncoding.EncodeToString([]byte(c.ID.String()))
}

func decodeCursor(s string) (*Cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(string(raw))
	if err != nil {
		return nil, fmt.Errorf("cursor: parse id: %w", err)
	}
	return &Cursor{ID: id}, nil
}

// Составной курсор (время, id) — у листинга черновиков и у ленты «Все ответы» он
// один: там черновик МЕНЯЕТСЯ, пока человек печатает, тут склеены два множества с
// разными id. Кодируется теми же правилами, что одноколоночный: непрозрачная для
// клиента base64url-строка.
const timeCursorSep = "|"

func parseTimeCursor(w http.ResponseWriter, r *http.Request) (*TimeCursor, bool) {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return nil, true
	}
	c, err := decodeTimeCursor(raw)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный курсор", domain.ErrValidation))
		return nil, false
	}
	return c, true
}

func encodeTimeCursor(c TimeCursor) string {
	s := c.At.UTC().Format(time.RFC3339Nano) + timeCursorSep + c.ID.String()
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func decodeTimeCursor(s string) (*TimeCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	at, id, ok := strings.Cut(string(raw), timeCursorSep)
	if !ok {
		return nil, fmt.Errorf("time cursor: нет разделителя")
	}
	ts, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return nil, fmt.Errorf("time cursor: parse time: %w", err)
	}
	rowID, err := uuid.Parse(id)
	if err != nil {
		return nil, fmt.Errorf("time cursor: parse id: %w", err)
	}
	return &TimeCursor{At: ts, ID: rowID}, nil
}
