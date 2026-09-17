package forms

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// maxConsentBodyBytes — потолок тела раздела «Персональные данные». Больше общего: в
// теле два своих текста по MaxConsentDocTextLen рун, а кириллица в UTF-8 — два байта
// на руну. Потолок длины в рунах стережёт ValidateConsentSettings.
const maxConsentBodyBytes = 512 << 10

// consentBody — раздел «Персональные данные» в теле запроса и ответа: поля
// domain.ConsentSettings как есть, его JSON-теги и есть контракт.
type consentBody = domain.ConsentSettings

type consentRequest struct {
	Enabled bool `json:"enabled"`
	consentBody
}

// consentResponse — тело GET и PUT /forms/{id}/consent. revisionId/updatedAt — null у
// формы, где раздел не сохраняли.
type consentResponse struct {
	Enabled bool `json:"enabled"`
	consentBody
	RevisionID *string    `json:"revisionId"`
	UpdatedAt  *time.Time `json:"updatedAt"`
}

func toConsentResponse(st ConsentState) consentResponse {
	resp := consentResponse{
		Enabled:     st.Enabled,
		consentBody: st.Settings,
		UpdatedAt:   st.UpdatedAt,
	}
	if st.RevisionID != nil {
		id := st.RevisionID.String()
		resp.RevisionID = &id
	}
	return resp
}

type consentDocumentBody struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

type consentPreviewResponse struct {
	Consent consentDocumentBody `json:"consent"`
	Policy  consentDocumentBody `json:"policy"`
}

// decodeConsent разбирает тело строго: лишнее поле — ошибка ввода, а не молчание.
// Превышение потолка — 413, а не «неверное тело»: автор вставил слишком длинный
// документ, и сказать ему нужно именно это.
func decodeConsent[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var req T
	r.Body = http.MaxBytesReader(w, r.Body, maxConsentBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxConsentBodyBytes))
			return req, false
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return req, false
	}
	return req, true
}

func (h *Handler) getConsent(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	st, err := h.svc.Consent(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toConsentResponse(st))
}

func (h *Handler) putConsent(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	req, ok := decodeConsent[consentRequest](w, r)
	if !ok {
		return
	}
	st, err := h.svc.SaveConsent(r.Context(), userID, formID, req.Enabled, req.consentBody)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toConsentResponse(st))
}

// previewConsent — оба документа по несохранённым настройкам. POST, а не GET: настройки
// едут телом, и в адрес их класть нельзя — там реквизиты оператора.
func (h *Handler) previewConsent(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	req, ok := decodeConsent[consentBody](w, r)
	if !ok {
		return
	}
	consent, policy, err := h.svc.ConsentPreview(r.Context(), userID, formID, req)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, consentPreviewResponse{
		Consent: consentDocumentBody{Title: consent.Title, Text: consent.Text},
		Policy:  consentDocumentBody{Title: policy.Title, Text: policy.Text},
	})
}

// consentOperatorView — строка списка реквизитов пространства.
type consentOperatorView struct {
	ID string `json:"id"`
	domain.ConsentOperator
}

func (h *Handler) consentOperators(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	// {id} здесь — пространство; разбор тот же, что у формы: мусор → 404.
	workspaceID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	items, err := h.svc.ConsentOperators(r.Context(), userID, workspaceID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]consentOperatorView, 0, len(items))
	for _, it := range items {
		out = append(out, consentOperatorView{ID: it.ID.String(), ConsentOperator: it.ConsentOperator})
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"items": out})
}

func (h *Handler) deleteConsentOperator(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	// {id} здесь — строка списка; разбор тот же, что у формы.
	operatorID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteConsentOperator(r.Context(), userID, operatorID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// consentDocument — GET /public/v1/forms/{slug}/documents/{kind}?revision=…&version=…:
// документ согласия или политики для страницы на домене форм. Неразбираемые
// параметры — 404, как у несуществующего документа: гадать по коду ответа нечего.
//
// Кэша нет вовсе: у формы под паролем ответ зависит от заголовка разблокировки,
// которого нет в ключе общего кэша, а страница документа открывается редко.
func (h *PublicHandler) consentDocument(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	q := r.URL.Query()
	revisionID, err := uuid.Parse(q.Get("revision"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	var version int32
	if raw := q.Get("version"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || n < 1 {
			httpserver.WriteError(w, r, domain.ErrNotFound)
			return
		}
		version = int32(n)
	}
	doc, err := h.svc.PublicConsentDocument(r.Context(), r.PathValue("slug"),
		domain.ConsentDocKind(r.PathValue("kind")), revisionID, version, r.Header.Get(UnlockHeader))
	if err != nil {
		if !errors.Is(err, domain.ErrNotFound) && !errors.Is(err, domain.ErrFormLocked) {
			err = fmt.Errorf("consent document %s: %w", r.PathValue("slug"), err)
		}
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, consentDocumentBody{Title: doc.Title, Text: doc.Text})
}
