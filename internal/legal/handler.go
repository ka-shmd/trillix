package legal

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// legalService — интерфейс сервиса, нужный транспорту (реализация — *Service).
type legalService interface {
	Current(ctx context.Context) ([]Edition, error)
	Document(ctx context.Context, kind Kind, version string) (Edition, []VersionRef, error)
}

// Handler — HTTP-транспорт модуля legal. Документы публичны: политику обязаны видеть до
// регистрации (ч. 2 ст. 18.1 152-ФЗ), а соглашение — до его принятия.
type Handler struct {
	svc legalService
}

func NewHandler(svc legalService) *Handler {
	return &Handler{svc: svc}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/legal/documents", http.HandlerFunc(h.list))
	mux.Handle("GET /api/v1/legal/documents/{kind}", http.HandlerFunc(h.document))
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
