package legal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// maxBodyBytes — потолок тела ручки согласий: два документа и две версии.
const maxBodyBytes = 4 << 10

// Middleware — HTTP-обёртка из auth (RequireSession, RequireCSRF), инжектируемая в
// composition root.
type Middleware = func(http.Handler) http.Handler

// legalService — интерфейс сервиса, нужный транспорту (реализация — *Service).
type legalService interface {
	Current(ctx context.Context) ([]Edition, error)
	Document(ctx context.Context, kind Kind, version string) (Edition, []VersionRef, error)
	State(ctx context.Context, actor Actor) (View, error)
	Apply(ctx context.Context, actor Actor, change Change) (View, error)
}

// Handler — HTTP-транспорт модуля legal. Документы публичны: политику обязаны видеть до
// регистрации (ч. 2 ст. 18.1 152-ФЗ), а соглашение — до его принятия. Ручки согласий —
// за RequireSession, а не RequireAuth: именно ими снимается гейт согласия, и за гейтом
// они были бы недостижимы.
type Handler struct {
	svc            legalService
	requireSession Middleware
	requireCSRF    Middleware
}

func NewHandler(svc legalService, requireSession, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireSession: requireSession, requireCSRF: requireCSRF}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/legal/documents", http.HandlerFunc(h.list))
	mux.Handle("GET /api/v1/legal/documents/{kind}", http.HandlerFunc(h.document))
	mux.Handle("GET /api/v1/account/consents", h.requireSession(http.HandlerFunc(h.consents)))
	mux.Handle("POST /api/v1/account/consents", h.requireSession(h.requireCSRF(http.HandlerFunc(h.applyConsents))))
}

type documentSummary struct {
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Version     string    `json:"version"`
	EffectiveAt time.Time `json:"effectiveAt"`
}

type versionResponse struct {
	Version     string    `json:"version"`
	EffectiveAt time.Time `json:"effectiveAt"`
}

type documentResponse struct {
	documentSummary
	// Text — абзацы через пустую строку, как у документов согласия формы; рендерится
	// текстом (инвариант 4).
	Text     string            `json:"text"`
	Versions []versionResponse `json:"versions"`
}

func summaryOf(e Edition) documentSummary {
	return documentSummary{Kind: string(e.Kind), Title: e.Title, Version: e.Version, EffectiveAt: e.EffectiveAt}
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	editions, err := h.svc.Current(r.Context())
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	items := make([]documentSummary, len(editions))
	for i, e := range editions {
		items[i] = summaryOf(e)
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string][]documentSummary{"items": items})
}

func (h *Handler) document(w http.ResponseWriter, r *http.Request) {
	// Неизвестный вид и версия не по формату — 404, а не 422: адрес документа набирают
	// руками, и для человека это одно и то же «такой страницы нет».
	kind, ok := ParseKind(r.PathValue("kind"))
	if !ok {
		httpserver.WriteError(w, r, fmt.Errorf("%w: документ %q", domain.ErrNotFound, r.PathValue("kind")))
		return
	}
	version := r.URL.Query().Get("version")
	if version != "" && !datePattern.MatchString(version) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: редакция %q", domain.ErrNotFound, version))
		return
	}
	ed, versions, err := h.svc.Document(r.Context(), kind, version)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	resp := documentResponse{
		documentSummary: summaryOf(ed),
		Text:            ed.Body,
		Versions:        make([]versionResponse, len(versions)),
	}
	for i, v := range versions {
		resp.Versions[i] = versionResponse(v)
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

type offerResponse struct {
	Version     string    `json:"version"`
	Title       string    `json:"title"`
	EffectiveAt time.Time `json:"effectiveAt"`
	// Label — подпись галочки; Link — её часть, которая становится ссылкой на документ.
	Label string `json:"label"`
	Link  string `json:"link"`
}

type termsResponse struct {
	offerResponse
	AcceptedVersion *string    `json:"acceptedVersion"`
	AcceptedAt      *time.Time `json:"acceptedAt"`
}

type marketingResponse struct {
	offerResponse
	ToggleLabel    string     `json:"toggleLabel"`
	Granted        bool       `json:"granted"`
	GrantedVersion *string    `json:"grantedVersion"`
	ChangedAt      *time.Time `json:"changedAt"`
}

type historyResponse struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"`
	Version string    `json:"version"`
	Title   string    `json:"title"`
	Action  string    `json:"action"`
	Source  string    `json:"source"`
	At      time.Time `json:"at"`
}

type consentsResponse struct {
	// Screen — какой экран закрывает кабинет: "signup", "update" или null.
	Screen    *string            `json:"screen"`
	Terms     *termsResponse     `json:"terms"`
	Marketing *marketingResponse `json:"marketing"`
	History   []historyResponse  `json:"history"`
}

type applyConsentsRequest struct {
	Accept []struct {
		Kind    string `json:"kind"`
		Version string `json:"version"`
	} `json:"accept"`
	Withdraw []string `json:"withdraw"`
}

// actorOf — снимок аккаунта из сессии. Пользователь берётся из контекста, а не из тела:
// id в запросе не является доказательством права (инвариант безопасности 1).
func actorOf(r *http.Request) (Actor, bool) {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		return Actor{}, false
	}
	return Actor{
		UserID:          user.ID,
		Email:           user.Email,
		UserAgent:       r.UserAgent(),
		HasPassword:     user.PasswordHash != nil,
		SignupCompleted: user.SignupCompletedAt != nil,
	}, true
}

func (h *Handler) consents(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOf(r)
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	v, err := h.svc.State(r.Context(), actor)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toConsentsResponse(v))
}

func (h *Handler) applyConsents(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorOf(r)
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req applyConsentsRequest
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, domain.ErrTooLarge)
			return
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	change := Change{Withdraw: make([]Kind, len(req.Withdraw))}
	for _, a := range req.Accept {
		change.Accept = append(change.Accept, DocRef{Kind: Kind(a.Kind), Version: a.Version})
	}
	for i, k := range req.Withdraw {
		change.Withdraw[i] = Kind(k)
	}
	v, err := h.svc.Apply(r.Context(), actor, change)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toConsentsResponse(v))
}

func offerOf(o Offer) offerResponse {
	return offerResponse{
		Version: o.Edition.Version, Title: o.Edition.Title, EffectiveAt: o.Edition.EffectiveAt,
		Label: o.Label, Link: o.Link,
	}
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func toConsentsResponse(v View) consentsResponse {
	resp := consentsResponse{Screen: optional(string(v.Screen)), History: make([]historyResponse, len(v.History))}
	if v.Terms != nil {
		resp.Terms = &termsResponse{
			offerResponse:   offerOf(v.Terms.Offer),
			AcceptedVersion: optional(v.Terms.AcceptedVersion),
			AcceptedAt:      v.Terms.AcceptedAt,
		}
	}
	if v.Marketing != nil {
		resp.Marketing = &marketingResponse{
			offerResponse:  offerOf(v.Marketing.Offer),
			ToggleLabel:    v.Marketing.ToggleLabel,
			Granted:        v.Marketing.Granted,
			GrantedVersion: optional(v.Marketing.GrantedVersion),
			ChangedAt:      v.Marketing.ChangedAt,
		}
	}
	for i, it := range v.History {
		resp.History[i] = historyResponse{
			ID: it.ID.String(), Kind: string(it.Kind), Version: it.Version, Title: it.Title,
			Action: string(it.Action), Source: string(it.Source), At: it.At,
		}
	}
	return resp
}
