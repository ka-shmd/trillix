package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/token"
)

const (
	// maxSubmitBodyBytes — потолок тела приёма ответа (ARCHITECTURE §4.4). Превышение
	// → 413, а не молчаливое усечение.
	maxSubmitBodyBytes = 256 << 10

	// DefaultMinFillTime — минимальное правдоподобное время заполнения формы. Ответ,
	// пришедший быстрее (возраст токена меньше), — бот. Порог антиспама, одинаковый
	// во всех контурах (не env: смыслового различия между dev/prod нет).
	DefaultMinFillTime = 3 * time.Second

	// maxPartialBodyBytes — потолок тела автосохранения. Тот же, что у приёма ответа:
	// внутри ровно те же ответы, просто не все.
	maxPartialBodyBytes = maxSubmitBodyBytes

	// DefaultMaxTokenAge — максимальный возраст токена формы; смысл и обоснование —
	// token.MaxAge. Имя оставлено прежним: его читают тесты и хендлеры фазы 5.
	DefaultMaxTokenAge = token.MaxAge
)

// submitService — часть сервиса, нужная публичному транспорту приёма.
type submitService interface {
	Submit(ctx context.Context, slug string, id uuid.UUID, answers map[string]json.RawMessage, meta Meta) error
	SavePartial(ctx context.Context, slug string, p PartialInput) error
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
	limited := httpserver.RateLimitByIP(h.limiter, h.trustedProxy, "слишком много отправок")
	mux.Handle("POST /public/v1/forms/{slug}/submissions", limited(http.HandlerFunc(h.submit)))
	mux.Handle("POST /public/v1/forms/{slug}/partial", limited(http.HandlerFunc(h.savePartial)))
}

// submitRequest — тело POST. submission_id генерирует клиент (UUIDv7, идемпотентность);
// token — подписанное время выдачи из GET формы (антиспам); website — honeypot
// (скрытое поле, человек его не видит; заполнено → бот). Лишние поля запрещены.
type submitRequest struct {
	SubmissionID string                     `json:"submission_id"`
	Token        string                     `json:"token"`
	Answers      map[string]json.RawMessage `json:"answers"`
	Website      string                     `json:"website"` // honeypot
	// VisitID — визит, из которого пришёл ответ (фаза 8.5 шаг 6). НЕОБЯЗАТЕЛЬНОЕ:
	// пусто → ответ принимается как раньше. Иначе страница, отданная из кэша до
	// выкатки биконов, перестала бы отправляться.
	VisitID string `json:"visit_id"`
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
	// Неразбираемый visit_id не отклоняет ответ: аналитика не повод потерять данные
	// респондента. uuid.Nil = «визита нет», отметка конверсии просто не делается.
	if req.VisitID != "" {
		if visitID, err := uuid.Parse(req.VisitID); err == nil {
			meta.VisitID = visitID
		}
	}
	if err := h.svc.Submit(r.Context(), r.PathValue("slug"), id, req.Answers, meta); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, submitResponse{ID: id.String()})
}

// partialRequest — тело автосохранения. Лишние поля запрещены, как и у бикона.
type partialRequest struct {
	VisitID     string                     `json:"visit_id"`
	Token       string                     `json:"token"`
	Version     int32                      `json:"version"`
	Answers     map[string]json.RawMessage `json:"answers"`
	LastBlockID *string                    `json:"last_block_id"`
}

// savePartial принимает черновик — то, что человек набрал и пока не отправил.
//
// От приёма ответа отличается тремя вещами, и все три следуют из смысла черновика:
//
//   - НЕТ нижней границы возраста токена. «Слишком быстро» — признак бота у
//     отправки; у автосохранения он бессмыслен: первое сохранение уходит через
//     секунды после открытия формы, и общая проверка отбрасывала бы ровно тех, кого
//     мы собираемся считать.
//   - НЕТ honeypot. Скрытое поле проверяет отправку; черновик бота — мусор в
//     таблице владельца, но не поддельный ответ, а ведро лимитера у ручки своё.
//   - 204 без тела: клиент ответа не читает (последнее сохранение уходит биконом
//     через sendBeacon, который тела не получает вовсе).
func (h *PublicHandler) savePartial(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPartialBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	var req partialRequest
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxPartialBodyBytes))
			return
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	issuedAt, err := token.IssuedAt(h.tokenSecret, req.Token)
	if age := h.now().Sub(issuedAt); err != nil || age < 0 || age > DefaultMaxTokenAge {
		httpserver.WriteError(w, r, fmt.Errorf("%w: не удалось принять запрос", domain.ErrValidation))
		return
	}

	visitID, err := uuid.Parse(req.VisitID)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный visit_id", domain.ErrValidation))
		return
	}

	err = h.svc.SavePartial(r.Context(), r.PathValue("slug"), PartialInput{
		VisitID:     visitID,
		Version:     req.Version,
		Answers:     req.Answers,
		LastBlockID: req.LastBlockID,
	})
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
