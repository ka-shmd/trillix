package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/submissions"
)

// ChannelSheets — канал outbox для доставки в таблицы. Второй канал очереди
// после почты; ретраи, бэкофф и диспетчер у них общие (ADR §10).
const ChannelSheets = "gsheets"

// sheetsPayload — намерение доставки: ИДЕНТИФИКАТОРЫ, а не готовая строка.
// Собрать строку в момент приёма значило бы читать версии схемы внутри самого
// горячего эндпоинта продукта (ARCHITECTURE §4.7); транспорт делает то же в
// фоне, где лишний запрос ничего не стоит.
//
// Привязка адресуется своим id, а не id формы: отвязали и привязали заново, пока
// событие ждало, — старое событие не должно писать в новую таблицу.
type sheetsPayload struct {
	LinkID       uuid.UUID `json:"linkId"`
	SubmissionID uuid.UUID `json:"submissionId"`
}

// Outbox — очередь надёжной доставки наружу (internal/mail). Интерфейс на
// стороне потребителя: интеграциям нужен один метод из всего модуля почты.
type Outbox interface {
	Enqueue(ctx context.Context, db postgres.DBTX, channel string, payload []byte) error
}

// Submissions — строка ответа для внешней таблицы (internal/submissions). Модель
// колонок одна на выгрузку, сводку и таблицу, и живёт она там же, где ответы.
type Submissions interface {
	SheetRow(ctx context.Context, formID, submissionID uuid.UUID) (submissions.SheetRecord, error)
}

// WithDelivery подключает доставку ответов. Отдельным сеттером: submissions
// зовёт интеграции (поставить событие), интеграции зовут submissions (собрать
// строку) — в конструкторе такую пару не собрать.
func (s *Service) WithDelivery(out Outbox, subs Submissions) *Service {
	s.outbox, s.submissions = out, subs
	return s
}

// EnqueueSubmission ставит доставку принятого ответа. Форма не привязана к
// таблице — не работа и не ошибка: молча ничего не делаем.
//
// Зовётся ПОСЛЕ коммита ответа (submissions.enqueueIntegration): цена этого —
// одна потерянная строка при крахе в узком окне, и она названа там же.
func (s *Service) EnqueueSubmission(ctx context.Context, formID, submissionID uuid.UUID) error {
	if !s.Enabled() || s.outbox == nil {
		return nil
	}
	link, err := s.repo.GetLink(ctx, s.db, formID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("enqueue submission delivery: %w", err)
	}

	payload, err := json.Marshal(sheetsPayload{LinkID: link.ID, SubmissionID: submissionID})
	if err != nil {
		return fmt.Errorf("marshal sheets payload: %w", err)
	}
	return s.outbox.Enqueue(ctx, s.db, ChannelSheets, payload)
}

// Deliver — транспорт канала gsheets (mail.Transport). Ошибка означает «попробуй
// позже» и уходит в общий бэкофф; событие, которое доставлять НЕ надо, гасится
// возвратом nil — у outbox нет dead-letter, и вечный ретрай безнадёжной строки
// означал бы стук в чужой API до конца времён.
func (s *Service) Deliver(ctx context.Context, payload []byte) error {
	var p sheetsPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return fmt.Errorf("unmarshal sheets payload: %w", err)
	}
	if !s.Enabled() {
		// Ключи убрали из окружения, пока событие ждало. Ретраить нечем.
		return nil
	}

	link, err := s.repo.GetLinkByID(ctx, s.db, p.LinkID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // форму отвязали, пока событие ждало
	}
	if err != nil {
		return err
	}
	if link.Status == StatusBroken {
		// Интеграция уже помечена сломанной: причина показана человеку, лечение —
		// переподключение и перезалив. Копить события до тех пор незачем.
		return nil
	}

	record, err := s.submissions.SheetRow(ctx, link.FormID, p.SubmissionID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Ответ удалён автором или скрыт тарифом (over_quota) — доставлять нечего.
		return nil
	}
	if err != nil {
		return err
	}

	conn, err := s.repo.GetAccountByID(ctx, s.db, link.AccountID)
	if err != nil {
		return err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return s.deliveryFailed(ctx, link, err)
	}

	// Колонки листа могли отстать от формы: в ней появился новый вопрос.
	columns, err := s.reconcileColumns(ctx, token, link, record.Columns)
	if err != nil {
		return s.deliveryFailed(ctx, link, err)
	}

	row := alignRow(columns, record)
	if err := s.google.AppendRow(ctx, token, spreadsheetOf(link), row); err != nil {
		return s.deliveryFailed(ctx, link, err)
	}
	return s.repo.MarkDelivered(ctx, s.db, link.ID)
}

// deliveryFailed разбирает отказ: окончательный помечает интеграцию сломанной и
// ГАСИТ событие (nil), временный уходит на ретрай.
func (s *Service) deliveryFailed(ctx context.Context, link FormLink, cause error) error {
	if !errors.Is(cause, ErrPermanent) {
		return cause
	}
	httpserver.LoggerFrom(ctx).Warn("integration marked broken",
		slog.String("form_id", link.FormID.String()),
		slog.String("error", cause.Error()))
	if err := s.repo.MarkBroken(ctx, s.db, link.ID, brokenReason(cause)); err != nil {
		return err
	}
	return nil
}

// brokenReason — человеческий текст причины для кабинета. Текст ошибки
// провайдера туда не уходит: он на английском и про HTTP, а читать его будет
// автор формы.
func brokenReason(error) string {
	return "Google больше не принимает записи в эту таблицу: доступ отозван или таблица удалена. Переподключите аккаунт и создайте таблицу заново."
}

// reconcileColumns доводит колонки листа до колонок формы. Правило — колонка
// ТОЛЬКО ДОБАВЛЯЕТСЯ: удалённый вопрос свою колонку сохраняет (в ней живут
// ответы прошлых версий), а сдвиг разъехался бы с тем, что автор уже свёл
// формулами справа.
func (s *Service) reconcileColumns(ctx context.Context, token string, link FormLink, actual []domain.SheetColumn) ([]domain.SheetColumn, error) {
	known := make(map[string]bool, len(link.Columns))
	for _, c := range link.Columns {
		known[c.Key] = true
	}
	columns, added := link.Columns, false
	for _, c := range actual {
		if !known[c.Key] {
			columns, added = append(columns, c), true
		}
	}
	if !added {
		return link.Columns, nil
	}

	// Шапка переписывается целиком: у append нет «допиши колонку», а строка
	// заголовков в листе одна.
	if err := s.google.WriteHeader(ctx, token, spreadsheetOf(link), columnLabels(columns)); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateLinkColumns(ctx, s.db, link.ID, columns); err != nil {
		return nil, err
	}
	return columns, nil
}

// alignRow раскладывает значения ответа по колонкам ЛИСТА. Порядок берётся у
// листа, а не у формы: колонка удалённого вопроса осталась на месте, и значения
// без этой раскладки уехали бы на одну влево — под чужой заголовок.
func alignRow(columns []domain.SheetColumn, record submissions.SheetRecord) []string {
	byKey := make(map[string]string, len(record.Columns))
	for i, c := range record.Columns {
		if i < len(record.Row) {
			byKey[c.Key] = record.Row[i]
		}
	}
	row := make([]string, len(columns))
	for i, c := range columns {
		row[i] = byKey[c.Key]
	}
	return row
}

// spreadsheetOf — адрес листа для вызовов провайдера.
func spreadsheetOf(link FormLink) Spreadsheet {
	return Spreadsheet{
		ID:      link.SpreadsheetID,
		URL:     link.SpreadsheetURL,
		SheetID: link.SheetID,
		Title:   link.SheetTitle,
	}
}
