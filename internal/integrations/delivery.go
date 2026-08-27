package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

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
	// Backfill — событие догрузки накопленных ответов (слайс D), а не одного
	// нового. Одно событие = одна пачка: обойти двадцать тысяч ответов внутри
	// одного Deliver значило бы занять диспетчер, общий с почтой, на минуты.
	Backfill bool `json:"backfill,omitempty"`
	// After — курсор пачки (id последнего доставленного ответа). Прогресс живёт
	// в очереди, а не в памяти: перезапуск процесса не начинает догрузку заново.
	After uuid.UUID `json:"after,omitempty"`
}

// BackfillBatch — сколько ответов уезжает одним запросом к провайдеру. Пачками,
// потому что у Google 60 запросов в минуту на пользователя; не больше, потому
// что тело запроса и время его обработки растут вместе с пачкой, а диспетчер
// общий с почтой.
const BackfillBatch = 200

// errBackfillPending — живое событие пришло, пока идёт догрузка. Ошибка (то есть
// ретрай по общему бэкоффу), а не потеря: новые строки обязаны лечь ПОСЛЕ
// старых, иначе в листе получится перевёрнутая хронология.
var errBackfillPending = errors.New("integrations: идёт перенос накопленных ответов")

// Outbox — очередь надёжной доставки наружу (internal/mail). Интерфейс на
// стороне потребителя: интеграциям нужен один метод из всего модуля почты.
type Outbox interface {
	Enqueue(ctx context.Context, db postgres.DBTX, channel string, payload []byte) error
}

// Submissions — строка ответа для внешней таблицы (internal/submissions). Модель
// колонок одна на выгрузку, сводку и таблицу, и живёт она там же, где ответы.
type Submissions interface {
	SheetRow(ctx context.Context, formID, submissionID uuid.UUID) (submissions.SheetRecord, error)
	// SheetRows — пачка накопленных ответов для догрузки: строго до отсечки,
	// после курсора, старые сверху.
	SheetRows(ctx context.Context, formID uuid.UUID, before time.Time, after uuid.UUID, limit int32) (submissions.SheetPage, error)
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
	// Событие на КАЖДУЮ включённую связку: их у формы сколько угодно, и каждая
	// доставляется, ретраится и ломается сама по себе. Выключенные отсеиваются
	// здесь — событие, которое некому доставить, лучше не заводить вовсе.
	ids, err := s.repo.EnabledLinkIDs(ctx, s.db, formID)
	if err != nil {
		return fmt.Errorf("enqueue submission delivery: %w", err)
	}
	for _, id := range ids {
		payload, err := json.Marshal(sheetsPayload{LinkID: id, SubmissionID: submissionID})
		if err != nil {
			return fmt.Errorf("marshal sheets payload: %w", err)
		}
		if err := s.outbox.Enqueue(ctx, s.db, ChannelSheets, payload); err != nil {
			return err
		}
	}
	return nil
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
	// Человек, чьим аккаунтом едет связка, всё ещё в пространстве формы?
	//
	// Аккаунт Google принадлежит ЧЕЛОВЕКУ (ADR §10, 2026-08-27), и это плата за
	// личную модель: без сторожа ответы команды продолжали бы течь в Диск
	// бывшего участника после снятия доступа. Проверка стоит здесь, ВЫШЕ разбора
	// переноса, и покрывает оба вида событий: догрузка ушедшего участника —
	// ровно та же утечка, только пачкой.
	//
	// Гасим событие и красним связку: ретраить нечего (членство сама очередь не
	// вернёт), а владелец обязан увидеть причину текстом, а не гадать, почему
	// таблица встала.
	member, err := s.access.IsMember(ctx, link.WorkspaceID, link.AccountUserID)
	if err != nil {
		return err
	}
	if !member {
		httpserver.LoggerFrom(ctx).Warn("integration owner left the workspace",
			slog.String("link_id", link.ID.String()),
			slog.String("workspace_id", link.WorkspaceID.String()))
		return s.repo.MarkBroken(ctx, s.db, link.ID,
			"Доступ к пространству у владельца этого подключения Google снят — ответы в таблицу больше не уезжают. "+
				"Заведите связку заново своим аккаунтом.")
	}
	// Перенос идёт ВЫШЕ проверки тумблера и намеренно: он запускается явным
	// действием человека (подключение, правка цели, перезалив), а тумблер
	// говорит про НОВЫЕ ответы. Уроните эту очерёдность — и перенос, начатый на
	// выключенной связке, погаснет молча, оставив статус backfilling навсегда:
	// живые события после включения будут вечно ждать переноса, которого больше
	// никто не начнёт.
	if p.Backfill {
		return s.deliverBackfill(ctx, link, p.After)
	}
	if !link.Enabled {
		// Связку выключили, пока событие ждало. Тумблер — это «не доставлять»,
		// а не «доставить позже»: копить события до его возврата значит однажды
		// вывалить в таблицу всё разом.
		return nil
	}
	if link.Status == StatusBackfilling {
		return errBackfillPending
	}

	record, err := s.submissions.SheetRow(ctx, link.FormID, p.SubmissionID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Ответ удалён автором или скрыт тарифом (over_quota) — доставлять нечего.
		return nil
	}
	if err != nil {
		return err
	}

	// Ответ старше границы переноса — его уже положила туда догрузка.
	//
	// Событие могло быть поставлено ДО старта переноса (например, за секунду до
	// того, как человек переключил связку на другой лист) и доехать после его
	// конца: без этой проверки та же строка легла бы в лист дважды, а лечение —
	// перезалив — из интерфейса сейчас недоступно.
	if !link.BackfillBefore.IsZero() && record.CreatedAt.Before(link.BackfillBefore) {
		return nil
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

// Отсечка переноса — момент старта: всё, что придёт после неё, доставит живая
// очередь, а всё, что раньше, положит перенос.
// startBackfill помечает связку переносящейся и ставит первое событие пачки.
// db — исполнитель вызывающего: при подключении это транзакция, чтобы связка и
// событие легли вместе.
func (s *Service) startBackfill(ctx context.Context, db postgres.DBTX, linkID uuid.UUID) error {
	if err := s.repo.StartBackfill(ctx, db, linkID, time.Now()); err != nil {
		return err
	}
	return s.enqueueBackfill(ctx, db, linkID, uuid.Nil)
}

func (s *Service) enqueueBackfill(ctx context.Context, db postgres.DBTX, linkID, after uuid.UUID) error {
	if s.outbox == nil {
		return nil
	}
	payload, err := json.Marshal(sheetsPayload{LinkID: linkID, Backfill: true, After: after})
	if err != nil {
		return fmt.Errorf("marshal backfill payload: %w", err)
	}
	return s.outbox.Enqueue(ctx, db, ChannelSheets, payload)
}

// deliverBackfill доставляет ОДНУ пачку накопленных ответов и ставит следующую.
// Пачка кончилась раньше лимита — перенос завершён, доставка становится живой, и
// ждавшие в очереди новые ответы поедут своим чередом.
func (s *Service) deliverBackfill(ctx context.Context, link FormLink, after uuid.UUID) error {
	if link.Status != StatusBackfilling {
		// Перенос уже кончился (или перезалив начали заново, и это событие от
		// прошлого захода): гасим, иначе строки лягут дважды.
		return nil
	}

	page, err := s.submissions.SheetRows(ctx, link.FormID, link.BackfillBefore, after, BackfillBatch)
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

	columns, err := s.reconcileColumns(ctx, token, link, page.Columns)
	if err != nil {
		return s.deliveryFailed(ctx, link, err)
	}

	if len(page.Rows) > 0 {
		rows := make([][]string, 0, len(page.Rows))
		for _, r := range page.Rows {
			rows = append(rows, alignRow(columns, submissions.SheetRecord{Columns: page.Columns, Row: r.Values}))
		}
		if err := s.google.AppendRows(ctx, token, spreadsheetOf(link), rows); err != nil {
			return s.deliveryFailed(ctx, link, err)
		}
		if err := s.repo.MarkDelivered(ctx, s.db, link.ID); err != nil {
			return err
		}
	}

	// Неполная пачка = ответы кончились. Полная — ставим следующую с курсором
	// последней строки: прогресс живёт в очереди, а не в памяти процесса.
	if len(page.Rows) < BackfillBatch {
		return s.repo.FinishBackfill(ctx, s.db, link.ID)
	}
	return s.enqueueBackfill(ctx, s.db, link.ID, page.Rows[len(page.Rows)-1].ID)
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
func brokenReason(cause error) string {
	if errors.Is(cause, ErrSheetLayout) {
		return "Колонки листа больше не совпадают с вопросами формы — похоже, шапку правили вручную. " +
			"Верните её как было либо перезалейте лист: писать наугад мы не станем, чтобы ответы не легли под чужие заголовки."
	}
	return "Google больше не принимает записи в эту таблицу: доступ отозван или таблица удалена. Переподключите аккаунт и создайте таблицу заново."
}

// ErrSheetLayout — шапка листа разошлась с тем, что мы умеем в неё писать, и
// следовать ей безопасно нельзя.
//
// Окончательный отказ, а не ретрай: сам собой лист не починится, а писать «как
// помним» — это класть значения под чужие заголовки. Лечение в руках автора:
// вернуть колонки как было либо перезалить лист.
var ErrSheetLayout = fmt.Errorf("%w: раскладка колонок листа не читается", ErrPermanent)

// layoutOf — наши колонки в порядке листа.
//
// Сначала пробуем совпадение ПО ПОЗИЦИЯМ: шапка листа — префикс запомненных
// колонок. Так выглядит лист, которого никто не трогал (и лист, из которого
// автор убрал колонки с конца), то есть подавляющее большинство доставок.
//
// ⚠ Этот путь не оптимизация, а единственно верный для формы, где ДВА ВОПРОСА
// НАЗВАНЫ ОДИНАКОВО. Подписи у них неразличимы, и сопоставление по подписи
// объявило бы такую форму двусмысленной — то есть связка ломалась бы сразу
// после подключения, на листе, который продукт только что создал сам. Индексы
// же различимы всегда. Разбор по подписи остаётся там, где позиции уже не
// сходятся, — автор переставил или удалил колонку в середине.
func layoutOf(header []string, known []domain.SheetColumn) ([]domain.SheetColumn, error) {
	if len(header) <= len(known) {
		same := true
		for i, cell := range header {
			if cell != known[i].Label {
				same = false
				break
			}
		}
		if same {
			return known[:len(header)], nil
		}
	}
	return layoutFromHeader(header, known)
}

// layoutFromHeader сопоставляет ШАПКУ ЛИСТА с колонками, которые мы помним, и
// отдаёт наши колонки в порядке листа.
//
// Зачем вообще смотреть в лист. Лист принадлежит автору, и он вправе переставить
// колонки местами или убрать ненужную — Google это разрешает, и справка
// конкурента прямо это обещает. Запомненный при создании порядок после такой
// правки врёт, а `values.append` кладёт значения по позициям: строки поедут под
// чужие заголовки, и заметит это человек не скоро.
//
// Зовётся только когда позиции уже не сошлись (см. layoutOf).
//
// ⚠ Сопоставление идёт ПО ПОДПИСИ, и это единственное место, где так можно.
// Правило «колонка ↔ вопрос сопоставляются по ключу, а не по подписи»
// (INTEGRATIONS §8) сохраняется: здесь сопоставляются не колонка и вопрос, а
// ячейка шапки и НАША ЖЕ запись о ней — обе описывают один и тот же момент, и
// ключ достаётся из второй. Настоящая идентичность колонки, переживающая
// переименование вопроса, — developer metadata Google Sheets; она в очереди
// (BACKLOG), и до неё правило ниже страхует нас отказом, а не догадкой.
//
// Что считается «следовать нельзя»:
//   - подпись шапки не опознана, а ПОСЛЕ неё идёт опознанная. Писать пришлось бы
//     с пропуском в середине, а append умеет только сплошную строку от колонки A;
//   - одна и та же подпись у двух наших колонок и она встретилась в шапке:
//     какая из них — неизвестно, а угадывать значит однажды угадать неверно.
//
// Неопознанный ХВОСТ шапки (автор добавил свою колонку справа — например, с
// формулой местного времени) законен: мы просто не пишем в него, строка выходит
// короче ширины листа, и чужие ячейки остаются нетронутыми.
func layoutFromHeader(header []string, known []domain.SheetColumn) ([]domain.SheetColumn, error) {
	byLabel := make(map[string][]int, len(known))
	for i, c := range known {
		byLabel[c.Label] = append(byLabel[c.Label], i)
	}

	out := make([]domain.SheetColumn, 0, len(known))
	used := make([]bool, len(known))
	alienAt := -1
	for i, cell := range header {
		idx := -1
		for _, candidate := range byLabel[cell] {
			if used[candidate] {
				continue
			}
			if idx != -1 {
				// Двусмысленность: две наши колонки с одинаковой подписью, и обе
				// свободны. Молча взять первую значит однажды перемешать данные.
				return nil, fmt.Errorf("%w: подпись %q встречается у двух колонок", ErrSheetLayout, cell)
			}
			idx = candidate
		}
		if idx == -1 {
			if alienAt == -1 {
				alienAt = i
			}
			continue
		}
		if alienAt != -1 {
			return nil, fmt.Errorf("%w: между нашими колонками появилась посторонняя (позиция %d)", ErrSheetLayout, alienAt+1)
		}
		used[idx] = true
		out = append(out, known[idx])
	}
	return out, nil
}

// reconcileColumns приводит наше представление о колонках к тому, что в листе
// СЕЙЧАС, и дописывает колонки вопросов, которых в шапке ещё нет.
//
// Колонка по-прежнему только добавляется: удалённый вопрос свою колонку в листе
// сохраняет (в ней живут ответы прошлых версий). Но если колонку убрал САМ
// АВТОР, она не возвращается — в его таблице распоряжается он.
func (s *Service) reconcileColumns(ctx context.Context, token string, link FormLink, actual []domain.SheetColumn) ([]domain.SheetColumn, error) {
	header, err := s.google.ReadHeader(ctx, token, spreadsheetOf(link))
	if err != nil {
		return nil, err
	}
	// Пустая шапка — лист, который автор очистил целиком (или наш же, если
	// запись шапки при создании не доехала). Пишем свою и продолжаем: это не
	// расхождение, а отсутствие данных.
	if len(header) == 0 {
		if err := s.google.WriteHeader(ctx, token, spreadsheetOf(link), columnLabels(link.Columns)); err != nil {
			return nil, err
		}
		return link.Columns, nil
	}

	layout, err := layoutOf(header, link.Columns)
	if err != nil {
		return nil, err
	}

	// Колонки, которых в листе больше нет: автор их убрал. Мы их не возвращаем,
	// но и не забываем — иначе вопрос, чью колонку он удалил, на следующей же
	// доставке выглядел бы новым и приезжал обратно. И так каждый раз.
	dropped := columnsMissingFrom(layout, link.Columns)

	// Новый вопрос — тот, которого нет НИ в листе, НИ в нашей памяти. Проверять
	// только лист нельзя: удалённая автором колонка тоже отсутствует в нём.
	missing := columnsMissingFrom(append(append([]domain.SheetColumn{}, layout...), dropped...), actual)
	if len(missing) == 0 {
		return layout, s.rememberColumns(ctx, link, layout, dropped)
	}

	// Дописать колонку можно только В КОНЕЦ нашей части. Если справа от неё
	// стоят чужие колонки автора, места нет: append умеет сплошную строку от
	// колонки A, и новая колонка либо затрёт чужую, либо оставит пропуск.
	if len(header) > len(layout) {
		return nil, fmt.Errorf("%w: справа от наших колонок есть посторонние, новую колонку вопроса дописать некуда", ErrSheetLayout)
	}

	columns := append(append([]domain.SheetColumn{}, layout...), missing...)
	// Шапка переписывается целиком: у append нет «допиши колонку», а строка
	// заголовков в листе одна.
	if err := s.google.WriteHeader(ctx, token, spreadsheetOf(link), columnLabels(columns)); err != nil {
		return nil, err
	}
	return columns, s.rememberColumns(ctx, link, columns, dropped)
}

// rememberColumns сохраняет колонки связки: сначала те, что есть в листе, за
// ними — убранные автором. Пишем только при расхождении: у формы без правок
// порядок не меняется годами, а строка связки читается на каждый ответ.
//
// Убранные хранятся ХВОСТОМ и в лист не пишутся. Они нужны ровно за тем, чтобы
// отличать «автор убрал колонку» от «в форме появился новый вопрос»: без этой
// памяти первое неотличимо от второго, и удалённая колонка возвращалась бы на
// каждой доставке.
func (s *Service) rememberColumns(ctx context.Context, link FormLink, inSheet, dropped []domain.SheetColumn) error {
	columns := append(append([]domain.SheetColumn{}, inSheet...), dropped...)
	if sameColumns(link.Columns, columns) {
		return nil
	}
	return s.repo.UpdateLinkColumns(ctx, s.db, link.ID, columns)
}

func sameColumns(a, b []domain.SheetColumn) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Key != b[i].Key {
			return false
		}
	}
	return true
}

// columnsMissingFrom — какие из want отсутствуют в have. Порядок сохраняется от
// want: новые вопросы встают справа в том же порядке, в каком заданы в форме.
func columnsMissingFrom(have, want []domain.SheetColumn) []domain.SheetColumn {
	seen := make(map[string]bool, len(have))
	for _, c := range have {
		seen[c.Key] = true
	}
	var out []domain.SheetColumn
	for _, c := range want {
		if !seen[c.Key] {
			out = append(out, c)
		}
	}
	return out
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
