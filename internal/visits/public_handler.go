package visits

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
	// maxVisitBodyBytes — потолок тела бикона. На два порядка меньше, чем у приёма
	// ответа: внутри — id, номер версии, id блока и метки источника, ответов нет.
	maxVisitBodyBytes = 4 << 10

	// maxTokenAge — верхняя граница возраста токена формы (переиспользование старого,
	// TD-6). Зеркалит submissions.DefaultMaxTokenAge по значению, но своя: модули не
	// делят константы, а нижнюю границу (минимальное время заполнения) визиты не
	// применяют вовсе — см. комментарий в record.
	maxTokenAge = 24 * time.Hour
)

// recordService — часть сервиса, нужная публичному транспорту.
type recordService interface {
	Record(ctx context.Context, slug string, v Visit) error
}

// PublicHandler — публичный транспорт записи визитов (без авторизации/CSRF).
// Держит секрет токена формы и своё ведро лимитера.
type PublicHandler struct {
	svc          recordService
	limiter      httpserver.RateLimiter
	tokenSecret  []byte
	trustedProxy bool
	now          func() time.Time // подменяется в тестах
}

func NewPublicHandler(svc recordService, limiter httpserver.RateLimiter, tokenSecret []byte, trustedProxy bool) *PublicHandler {
	return &PublicHandler{
		svc:          svc,
		limiter:      limiter,
		tokenSecret:  tokenSecret,
		trustedProxy: trustedProxy,
		now:          time.Now,
	}
}

func (h *PublicHandler) Routes(mux *http.ServeMux) {
	limited := httpserver.RateLimitByIP(h.limiter, h.trustedProxy, "слишком много запросов")
	mux.Handle("POST /public/v1/forms/{slug}/visits", limited(http.HandlerFunc(h.record)))
}

// visitRequest — тело бикона. Лишние поля запрещены. Поля submitted тут нет и быть
// не может: конверсию ставит сервер при приёме ответа, иначе она подделывается с
// клиента, а поздний бикон затирает её обратно.
type visitRequest struct {
	VisitID     string            `json:"visit_id"`
	Token       string            `json:"token"`
	Version     int32             `json:"version"`
	LastBlockID *string           `json:"last_block_id"`
	Seq         int16             `json:"seq"`
	UTM         map[string]string `json:"utm"`
	// Page — бикон перехода на страницу (фаза 30): last_block_id — первый вопрос
	// открытой страницы, и она ложится в путь визита. Необязателен.
	Page bool `json:"page"`
}

func (h *PublicHandler) record(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxVisitBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	var req visitRequest
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxVisitBodyBytes))
			return
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	// Токен формы — тот же, что у приёма ответа, но окно другое: проверяем ТОЛЬКО
	// верхнюю границу (24 ч, переиспользование старого токена). Нижняя граница
	// (минимальное время заполнения) здесь неприменима по смыслу — бикон «открыли»
	// уходит через миллисекунды после выдачи токена, и общая проверка отбрасывала
	// бы ровно тех, кого мы считаем.
	issuedAt, err := token.IssuedAt(h.tokenSecret, req.Token)
	if age := h.now().Sub(issuedAt); err != nil || age < 0 || age > maxTokenAge {
		httpserver.WriteError(w, r, fmt.Errorf("%w: не удалось принять запрос", domain.ErrValidation))
		return
	}

	id, err := uuid.Parse(req.VisitID)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный visit_id", domain.ErrValidation))
		return
	}

	v := Visit{
		ID:          id,
		Version:     req.Version,
		LastBlockID: req.LastBlockID,
		Seq:         req.Seq,
		Page:        req.Page,
		UserAgent:   r.UserAgent(),
		Referer:     r.Referer(),
		UTM:         req.UTM,
		// Адрес берётся из соединения (за нашим прокси — из X-Forwarded-For), а не
		// из тела: телу верить нельзя, и поля для него в биконе нет. Нужен он ровно
		// для поиска страны и города по локальному справочнику — дальше сервиса не
		// уходит и никуда не сохраняется (ADR §10).
		IP: httpserver.ClientIP(r, h.trustedProxy),
	}
	if err := h.svc.Record(r.Context(), r.PathValue("slug"), v); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// 204: бикон ответ не читает (sendBeacon возвращает только «поставлено в очередь»),
	// тело было бы трафиком в никуда.
	w.WriteHeader(http.StatusNoContent)
}
