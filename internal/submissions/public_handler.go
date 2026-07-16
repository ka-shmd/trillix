package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/httpserver"
	"github.com/ka-shmd/trierra/internal/token"
)

const (
	// maxSubmitBodyBytes — потолок тела приёма ответа (ARCHITECTURE §4.4). Превышение
	// → 413, а не молчаливое усечение.
	maxSubmitBodyBytes = 256 << 10

	// DefaultMinFillTime — минимальное правдоподобное время заполнения формы. Ответ,
	// пришедший быстрее (возраст токена меньше), — бот. Порог антиспама, одинаковый
	// во всех контурах (не env: смыслового различия между dev/prod нет).
	DefaultMinFillTime = 3 * time.Second

	// DefaultMaxTokenAge — максимальный возраст токена формы. Без верхней границы бот
	// получает форму один раз, ждёт minFillTime и шлёт тем же токеном неограниченно
	// (TD-6): проверка min-fill-time становится разовым барьером. Правдоподобная сессия
	// заполнения укладывается в сутки; пришедший позже токен — переиспользование → 422.
	// Как и min, одинаков во всех контурах (не env).
	DefaultMaxTokenAge = 24 * time.Hour
)

// submitService — часть сервиса, нужная публичному транспорту приёма.
type submitService interface {
	Submit(ctx context.Context, slug string, id uuid.UUID, answers map[string]json.RawMessage, meta Meta) error
}

// RateLimiter — жёсткий лимитер по IP на приём ответа (отдельный от общего и от
// логина). Реализация — ratelimit.TokenBucket; в тестах — пермиссивный (инвариант 6).
type RateLimiter interface {
	Allow(key string) bool
}

// PublicHandler — публичный транспорт приёма ответов (без авторизации/CSRF). Держит
// секрет токена (проверка минимального времени заполнения) и лимитер.
type PublicHandler struct {
	svc          submitService
	limiter      RateLimiter
	tokenSecret  []byte
	minFillTime  time.Duration
	trustedProxy bool             // за доверенным прокси? влияет на извлечение IP клиента
	now          func() time.Time // подменяется в тестах
}

func NewPublicHandler(svc submitService, limiter RateLimiter, tokenSecret []byte, minFillTime time.Duration, trustedProxy bool) *PublicHandler {
	return &PublicHandler{
		svc:          svc,
		limiter:      limiter,
		tokenSecret:  tokenSecret,
		minFillTime:  minFillTime,
		trustedProxy: trustedProxy,
		now:          time.Now,
	}
}

func (h *PublicHandler) Routes(mux *http.ServeMux) {
	mux.Handle("POST /public/v1/forms/{slug}/submissions", h.rateLimitByIP(http.HandlerFunc(h.submit)))
}

// submitRequest — тело POST. submission_id генерирует клиент (UUIDv7, идемпотентность);
// token — подписанное время выдачи из GET формы (антиспам); website — honeypot
// (скрытое поле, человек его не видит; заполнено → бот). Лишние поля запрещены.
type submitRequest struct {
	SubmissionID string                     `json:"submission_id"`
	Token        string                     `json:"token"`
	Answers      map[string]json.RawMessage `json:"answers"`
	Website      string                     `json:"website"` // honeypot
}

type submitResponse struct {
	ID string `json:"id"`
}

func (h *PublicHandler) submit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSubmitBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	var req submitRequest
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxSubmitBodyBytes))
			return
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	// Honeypot: заполненное скрытое поле — признак бота. Отвечаем как на успех
	// (200), но ничего не пишем — бот не понимает, что отброшен, и не подстраивается.
	if req.Website != "" {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Возраст токена: подпись + окно [minFillTime, DefaultMaxTokenAge]. Слишком быстрый
	// ответ (бот) и переиспользование старого токена (TD-6) отбрасываются; битый/
	// поддельный токен неотличим для клиента (единый 422 с нейтральным текстом), чтобы
	// не подсказывать боту, какой из барьеров он задел, и не вводить в заблуждение
	// человека, вернувшегося к форме позже (для него «слишком быстро» — ложь).
	issuedAt, err := token.IssuedAt(h.tokenSecret, req.Token)
	if age := h.now().Sub(issuedAt); err != nil || age < h.minFillTime || age > DefaultMaxTokenAge {
		httpserver.WriteError(w, r, fmt.Errorf("%w: не удалось принять ответ, обновите форму и попробуйте снова", domain.ErrValidation))
		return
	}

	id, err := uuid.Parse(req.SubmissionID)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный submission_id", domain.ErrValidation))
		return
	}

	meta := Meta{UserAgent: r.UserAgent(), Referer: r.Referer()}
	if err := h.svc.Submit(r.Context(), r.PathValue("slug"), id, req.Answers, meta); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, submitResponse{ID: id.String()})
}

func (h *PublicHandler) rateLimitByIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.limiter.Allow(httpserver.ClientIP(r, h.trustedProxy)) {
			w.Header().Set("Retry-After", "60")
			httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много отправок", domain.ErrRateLimited))
			return
		}
		next.ServeHTTP(w, r)
	})
}
