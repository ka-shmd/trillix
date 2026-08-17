package answerfiles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/token"
)

// maxSlotBodyBytes — потолок тела заявки на слот (инвариант 3). Тело крошечное:
// имя файла, размер и тип. Байты самого файла сюда не приходят вовсе.
const maxSlotBodyBytes = 8 << 10

// slotService — часть сервиса, нужная публичному транспорту.
type slotService interface {
	IssueSlot(ctx context.Context, req SlotRequest) (Slot, error)
}

// RateLimiter — ведро по IP. Своё, отдельное от приёма ответа и от логина: выдача
// слота дороже приёма (она пишет строку и открывает право записи в бакет), и
// делить с ними ведро значило бы, что шквал загрузок закрывает форму для тех, кто
// просто отвечает. В тестах подменяется пермиссивной (инвариант 6).
type RateLimiter interface {
	Allow(key string) bool
}

// PublicHandler — публичный транспорт выдачи слотов. Без сессии и без CSRF: его
// зовёт респондент, которого мы не знаем. Единственное, что отличает его от
// постороннего с curl, — токен формы, поэтому проверка токена здесь такая же, как
// на приёме ответа.
type PublicHandler struct {
	svc          slotService
	limiter      RateLimiter
	tokenSecret  []byte
	minFillTime  time.Duration
	trustedProxy bool
	now          func() time.Time
}

func NewPublicHandler(svc slotService, limiter RateLimiter, tokenSecret []byte, minFillTime time.Duration, trustedProxy bool) *PublicHandler {
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
	limited := httpserver.RateLimitByIP(h.limiter, h.trustedProxy, "слишком много загрузок")
	mux.Handle("POST /public/v1/forms/{slug}/uploads", limited(http.HandlerFunc(h.issue)))
}

// slotRequest — тело заявки. Всё в нём — утверждения клиента, и ни одно не
// принимается на веру: размер и тип уезжают в подпись (хранилище отвергнет другие),
// имя чистится и хранится как данные, блок сверяется с опубликованной схемой.
type slotRequest struct {
	Token       string `json:"token"`
	BlockID     string `json:"block_id"`
	FileName    string `json:"file_name"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

// slotResponse — то, чем браузер грузит файл. upload_id уедет в ответ формы; url —
// учётные данные на пять минут.
type slotResponse struct {
	UploadID    string `json:"upload_id"`
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
	ExpiresIn   int    `json:"expires_in"`
}

func (h *PublicHandler) issue(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSlotBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	var req slotRequest
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxSlotBodyBytes))
			return
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	// Возраст токена — тот же барьер, что на приёме ответа: подпись плюс окно
	// [minFillTime, DefaultMaxTokenAge]. Без него право писать в наш бакет получал
	// бы любой, кто узнал slug формы. Причина отказа наружу не различается — иначе
	// бот узнавал бы, какой именно барьер задел.
	issuedAt, err := token.IssuedAt(h.tokenSecret, req.Token)
	if age := h.now().Sub(issuedAt); err != nil || age < h.minFillTime || age > token.MaxAge {
		httpserver.WriteError(w, r, fmt.Errorf("%w: не удалось принять файл, обновите форму и попробуйте снова", domain.ErrValidation))
		return
	}

	slot, err := h.svc.IssueSlot(r.Context(), SlotRequest{
		Slug:        r.PathValue("slug"),
		BlockID:     req.BlockID,
		FileName:    req.FileName,
		SizeBytes:   req.SizeBytes,
		ContentType: req.ContentType,
	})
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	// Адрес не логируется ни здесь, ни ниже: presigned-URL это учётные данные
	// (инвариант 7), и request-лог с ним превратил бы каждую загрузку в утечку.
	httpserver.WriteJSON(w, r, http.StatusOK, slotResponse{
		UploadID:    slot.ID.String(),
		URL:         slot.URL,
		ContentType: slot.ContentType,
		ExpiresIn:   int(slot.ExpiresIn.Seconds()),
	})
}
