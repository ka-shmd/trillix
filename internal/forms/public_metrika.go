package forms

import (
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/httpserver"
)

// metrika — номер счётчика Яндекс Метрики для этой выдачи (фаза 29 DEV-PLAN,
// docs/design/yandex-metrika.md §5); nil — счётчика на странице нет.
//
// Сбой опроса тарифа счётчик НЕ ставит: невзятая статистика дешевле, чем чужой
// скрипт на странице без права (у бейджа выбор обратный — там при сбое остаётся
// бренд). Причина уходит в лог с request_id.
func (h *PublicHandler) metrika(r *http.Request, workspaceID uuid.UUID, counter *string) *string {
	shown, err := h.svc.MetrikaFor(r.Context(), workspaceID, counter)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("metrika gate",
			slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
		return nil
	}
	return shown
}
