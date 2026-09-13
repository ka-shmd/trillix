package integrations

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Notifications — уведомления кабинета глазами этого модуля (internal/notify).
// Реализация — *notify.Service; nil = уведомлений в сборке нет, и доставка этого
// не замечает.
//
// Поломка цели — повод-ПРЕПЯТСТВИЕ, и у него две точки, а не одна: фронт (цель
// встала) и отбой (препятствие устранено). Без второй лента показывала бы
// «отвалилось» у цели, которая работает час как, — это названо строкой ADR.
type Notifications interface {
	Notify(ctx context.Context, db postgres.DBTX, ev notify.Event) error
	Clear(ctx context.Context, db postgres.DBTX, kind notify.Kind, subjectID uuid.UUID) error
}

// WithNotifications подключает уведомления кабинета.
func (s *Service) WithNotifications(n Notifications) *Service {
	s.notes = n
	return s
}

// brokenTarget — цель, которая встала, глазами повода: вид, имя, форма и причина.
// Имя цели и причина — те же строки, что видны на экране связки и в журнале
// доставок; своего текста повод не сочиняет (ADR §10).
type brokenTarget struct {
	workspaceID uuid.UUID
	formID      uuid.UUID
	targetID    uuid.UUID
	kind        string // sheet | webhook
	name        string
	formName    string
	formSlug    string
	reason      string
}

// noticeBroken ставит повод «цель не принимает» всем, кому можно видеть формы
// пространства. Best-effort: доставка уже провалилась, и вторая беда из-за
// ненаписанного уведомления никому не поможет — она уходит в лог.
func (s *Service) noticeBroken(ctx context.Context, t brokenTarget) {
	if s.notes == nil {
		return
	}
	err := s.notes.Notify(ctx, s.db, notify.Event{
		WorkspaceID: t.workspaceID,
		Kind:        notify.KindIntegrationBroken,
		FormID:      t.formID,
		// Субъект — ЦЕЛЬ, а не форма: у формы целей сколько угодно, и повод о
		// каждой живёт своей строкой со своим отбоем.
		SubjectID: t.targetID,
		Payload: notify.Payload{
			FormTitle:  t.formName,
			FormSlug:   t.formSlug,
			Target:     t.kind,
			TargetName: t.name,
			Reason:     t.reason,
		},
	})
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("broken target notification not stored",
			slog.String("target_id", t.targetID.String()), slog.String("error", err.Error()))
	}
}

// noticeFixed — отбой: препятствия больше нет, и непрочитанные строки о нём
// гаснут у всех разом. Зовётся там, где снимается поломка (перезалив, повтор,
// новый адрес, удачная проверка), и там, где цель удаляют: автор сносит
// сломанный вебхук именно потому, что тот сломан.
//
// Прочитанные строки отбой не трогает — они остаются историей.
func (s *Service) noticeFixed(ctx context.Context, targetID uuid.UUID) {
	if s.notes == nil {
		return
	}
	if err := s.notes.Clear(ctx, s.db, notify.KindIntegrationBroken, targetID); err != nil {
		httpserver.LoggerFrom(ctx).Warn("broken target notification not cleared",
			slog.String("target_id", targetID.String()), slog.String("error", err.Error()))
	}
}
