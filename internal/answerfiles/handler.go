package answerfiles

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth из auth), инжектируемая в хендлер: тот же
// приём, что в forms и media.
type Middleware = func(http.Handler) http.Handler

// downloadService — часть сервиса, нужная приватному транспорту.
type downloadService interface {
	DownloadURL(ctx context.Context, userID, fileID uuid.UUID) (Download, error)
}

// Handler — приватный транспорт скачивания файлов ответов.
type Handler struct {
	svc         downloadService
	requireAuth Middleware
}

func NewHandler(svc downloadService, requireAuth Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth}
}

// Routes регистрирует приватные эндпоинты. Адрес — по файлу, а не по форме и
// ответу: право доступа всё равно резолвится от формы, к которой файл приложен, и
// лишние сегменты пути дали бы второй, ничего не проверяющий источник той же
// правды (совпадение id в URL правом доступа не является).
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/files/{id}", h.requireAuth(http.HandlerFunc(h.download)))
}

// download отвечает редиректом на короткую подпись хранилища. Своим потоком байты
// не проксируются (DoD фазы), а сама подпись живёт минуту и не кэшируется: это
// учётные данные, и промежуточный кэш, сохранивший 302, раздавал бы чужой файл.
func (h *Handler) download(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Неразбираемый id → 404 (несуществующий файл, без раскрытия), а не 400.
	fileID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}

	d, err := h.svc.DownloadURL(r.Context(), u.ID, fileID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	// Referrer-Policy у ответа кабинета уже strict-origin-when-cross-origin, но
	// адрес с подписью уезжает в Location, и его не должен подхватить ни лог
	// прокси, ни история: срок в минуту — вторая половина той же меры.
	http.Redirect(w, r, d.URL, http.StatusFound)
}
