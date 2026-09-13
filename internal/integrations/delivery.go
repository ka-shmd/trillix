package integrations

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/submissions"
)

// Расписание доставки в Таблицы. Модель — «очередь, разобранная по целям»
// (ADR §10): строка очереди говорит, ЧТО везти, а когда и как часто — состояние
// самой связки.
const (
	// SheetTickTargets — сколько связок берётся за один проход.
	SheetTickTargets = 20
	// SheetBatchPerTarget — сколько ответов увозится у одной связки за проход.
	//
	// Двести, а не десять, как у вебхука, и разница не в щедрости: у Таблиц пачка
	// это ОДИН запрос values.append на все строки, а у вебхука — N запросов
	// подряд. Лимит Google (60 запросов в минуту на пользователя) считает
	// запросы, поэтому перенос двадцати тысяч накопленных ответов возможен ровно
	// пачками; поштучно он упёрся бы в лимит на первой же сотне.
	SheetBatchPerTarget = 200
	// SheetConcurrency — сколько связок разбирается одновременно. Одна связка —
	// один слот: порядок строк в листе держится этим.
	SheetConcurrency = 4
	// SheetBackoffBase и SheetBackoffMax — пауза СВЯЗКИ после неудачи: первая
	// неудача — минута, дальше удвоение до часа.
	SheetBackoffBase = time.Minute
	SheetBackoffMax  = time.Hour
	// SheetBrokenAfter — сколько связка может не принимать подряд, прежде чем
	// считается сломанной. Отсчёт идёт от ПЕРВОЙ неудачи подряд, иначе он не
	// наступит никогда.
	SheetBrokenAfter = 24 * time.Hour
	// SheetQueueTTL — сколько ответ ждёт доставки. Тот же срок, что у журнала:
	// починили связку в пределах месяца — получите всё накопленное.
	SheetQueueTTL = DeliveryTTL
	// sheetCleanupBatch — сколько просроченных строк снимается за проход.
	sheetCleanupBatch = 500
)

// Submissions — строки ответов для внешней таблицы (internal/submissions).
// Модель колонок одна на выгрузку, сводку и таблицу, и живёт она там же, где
// ответы.
type Submissions interface {
	// SheetRows — пачка названных ответов: колонки один раз, строки со своими
	// id. Порядок задаёт очередь связки, а не эта выборка.
	SheetRows(ctx context.Context, formID uuid.UUID, ids []uuid.UUID) (submissions.SheetPage, error)
	// WebhookRow — тот же ответ телом вебхука (фаза 28): поля с типами и
	// название формы. Модель колонок общая с таблицей — иначе у вопроса «какие
	// у формы поля» стало бы два ответа.
	WebhookRow(ctx context.Context, formID, submissionID uuid.UUID) (submissions.WebhookRecord, error)
}

// WithDelivery подключает доставку ответов. Отдельным сеттером: submissions
// зовёт интеграции, интеграции зовут submissions (собрать строки) — в
// конструкторе такую пару не собрать.
func (s *Service) WithDelivery(subs Submissions) *Service {
	s.submissions = subs
	return s
}

// DeliverSheets отвозит одну пачку: связки, которым есть что везти и чьё время
// наступило. Возвращает число уехавших строк. Зовётся периодической задачей.
func (s *Service) DeliverSheets(ctx context.Context) (int, error) {
	if !s.Enabled() || s.submissions == nil {
		return 0, nil
	}
	links, err := s.repo.DueLinks(ctx, s.db, SheetTickTargets)
	if err != nil {
		return 0, err
	}

	var (
		sent atomic.Int64
		wg   sync.WaitGroup
		slot = make(chan struct{}, SheetConcurrency)
	)
	for _, link := range links {
		if ctx.Err() != nil {
			break // остановка процесса — не ошибка задачи
		}
		wg.Add(1)
		go func(link FormLink) {
			defer wg.Done()
			slot <- struct{}{}
			defer func() { <-slot }()
			sent.Add(int64(s.deliverLink(ctx, link)))
		}(link)
	}
	wg.Wait()
	return int(sent.Load()), nil
}

// deliverLink увозит пачку ответов ОДНОЙ связки — одним append, в порядке
// постановки. Неудача усыпляет связку целиком: остаток очереди ждёт следующего
// окна, а не добавляет запросов в лист, который уже не принимает.
func (s *Service) deliverLink(ctx context.Context, link FormLink) int {
	pending, err := s.repo.PendingSheetSubmissions(ctx, s.db, link.ID, SheetBatchPerTarget)
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("sheet queue not read",
			slog.String("link_id", link.ID.String()), slog.String("error", err.Error()))
		return 0
	}
	if len(pending) == 0 {
		return 0
	}
	// Предмет попытки для журнала — ПЕРВАЯ строка очереди: на ней попытка и
	// останавливается, если что-то пойдёт не так. Ровно так же одну строку
	// оставляет в ленте оборванная пачка вебхука.
	ref := refOfQueued(pending[0])

	// Человек, чьим аккаунтом едет связка, всё ещё в пространстве формы?
	//
	// Аккаунт Google принадлежит ЧЕЛОВЕКУ (ADR §10, 2026-08-27), и это плата за
	// личную модель: без сторожа ответы команды продолжали бы течь в Диск
	// бывшего участника после снятия доступа. Проверка стоит ВЫШЕ всего
	// остального и покрывает пачку целиком — догрузка ушедшего участника это та
	// же утечка, только разом.
	member, err := s.access.IsMember(ctx, link.WorkspaceID, link.AccountUserID)
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("integration membership not checked",
			slog.String("link_id", link.ID.String()), slog.String("error", err.Error()))
		return 0
	}
	if !member {
		httpserver.LoggerFrom(ctx).Warn("integration owner left the workspace",
			slog.String("link_id", link.ID.String()),
			slog.String("workspace_id", link.WorkspaceID.String()))
		s.breakLink(ctx, link, ref,
			"Доступ к пространству у владельца этого подключения Google снят — ответы в таблицу больше не уезжают. "+
				"Заведите связку заново своим аккаунтом.")
		return 0
	}

	ids := make([]uuid.UUID, 0, len(pending))
	for _, q := range pending {
		ids = append(ids, q.SubmissionID)
	}
	page, err := s.submissions.SheetRows(ctx, link.FormID, ids)
	if err != nil {
		// Беда НАША, а не Google: связку за неё усыплять нельзя, и в ленту автора
		// это не попадает — его вины тут нет. Попробуем следующим проходом.
		httpserver.LoggerFrom(ctx).Error("sheet rows not built",
			slog.String("link_id", link.ID.String()), slog.String("error", err.Error()))
		return 0
	}

	values := make(map[uuid.UUID][]string, len(page.Rows))
	for _, row := range page.Rows {
		values[row.ID] = row.Values
	}
	// Ответ, которого в пачке не оказалось, удалён автором или скрыт тарифом
	// (over_quota — скрытый от владельца ответ не должен всплыть у него же в
	// Таблице). Везти нечего: снимаем с очереди со строкой в журнале, иначе он
	// держал бы связку «занятой» вечно.
	// mark — граница версии строк, которые читал ЭТОТ проход: снимать с очереди
	// можно только их (см. DropSheetQueued). Максимум по пачке — её последняя
	// строка: выборка идёт по возрастанию enqueued_at.
	mark := pending[len(pending)-1].EnqueuedAt
	var (
		rows    [][]string
		carried []QueuedSheetRow
		gone    []uuid.UUID
	)
	for _, q := range pending {
		row, ok := values[q.SubmissionID]
		if !ok {
			gone = append(gone, q.SubmissionID)
			s.logDelivery(ctx, link.ID, refOfQueued(q), OutcomeSkipped,
				"Ответ удалён или скрыт лимитом тарифа — отправлять было нечего.", 0)
			continue
		}
		rows = append(rows, row)
		carried = append(carried, q)
	}
	if len(gone) > 0 {
		s.dropQueuedSheets(ctx, link.ID, gone, mark)
	}
	if len(rows) == 0 {
		return 0
	}

	conn, err := s.repo.GetAccountByID(ctx, s.db, link.AccountID)
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("integration account not read",
			slog.String("link_id", link.ID.String()), slog.String("error", err.Error()))
		return 0
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return s.sheetFailed(ctx, link, ref, err)
	}

	// Колонки листа могли отстать от формы: в ней появился новый вопрос.
	columns, err := s.reconcileColumns(ctx, token, link, page.Columns)
	if err != nil {
		return s.sheetFailed(ctx, link, ref, err)
	}
	aligned := make([][]string, 0, len(rows))
	for _, row := range rows {
		aligned = append(aligned, alignRow(columns, page.Columns, row))
	}
	if err := s.google.AppendRows(ctx, token, spreadsheetOf(link), aligned); err != nil {
		return s.sheetFailed(ctx, link, ref, err)
	}

	delivered := make([]uuid.UUID, 0, len(carried))
	for _, q := range carried {
		delivered = append(delivered, q.SubmissionID)
	}
	s.dropQueuedSheets(ctx, link.ID, delivered, mark)
	s.logDeliveredBatch(ctx, link.ID, carried)
	if err := s.repo.MarkDelivered(ctx, s.db, link.ID); err != nil {
		httpserver.LoggerFrom(ctx).Error("integration success not stored",
			slog.String("link_id", link.ID.String()), slog.String("error", err.Error()))
	}
	return len(aligned)
}

// logDeliveredBatch пишет в журнал исход УСПЕШНОЙ пачки: живой ответ — своей
// строкой, перенос — одной строкой на всю пачку.
//
// Разница не косметическая: перенос двадцати тысяч ответов дал бы двадцать тысяч
// строк в ленте и перестал бы читаться ровно там, где его открывают, — а живой
// ответ в ленте ищут поштучно («уехал ли вот этот»).
func (s *Service) logDeliveredBatch(ctx context.Context, linkID uuid.UUID, carried []QueuedSheetRow) {
	moved := int32(0)
	for _, q := range carried {
		if q.Backfill {
			moved++
			continue
		}
		s.logDelivery(ctx, linkID, refOfQueued(q), OutcomeDelivered, "", 1)
	}
	if moved > 0 {
		s.logDelivery(ctx, linkID, deliveryRef{kind: DeliveryKindBackfill}, OutcomeDelivered, "", moved)
	}
}

// dropQueuedSheets снимает строки с очереди. Отказ снятия доставку не роняет, но
// в лог уходит: те же ответы поедут в лист второй раз, а append дублей не
// замечает — человеку это лечится перезаливом, нам видно здесь.
func (s *Service) dropQueuedSheets(ctx context.Context, linkID uuid.UUID, ids []uuid.UUID, before time.Time) {
	if err := s.repo.DropSheetQueued(ctx, s.db, linkID, ids, before); err != nil {
		httpserver.LoggerFrom(ctx).Error("sheet queue rows not removed",
			slog.String("link_id", linkID.String()), slog.String("error", err.Error()))
	}
}

// sheetFailed разбирает отказ: окончательный ломает связку, временный усыпляет
// её до следующего окна. Очередь В ОБОИХ случаях остаётся — ответы копятся, и
// починка увозит их по порядку. В этом разница с погашенным событием outbox,
// которое вернуть было бы нечем.
func (s *Service) sheetFailed(ctx context.Context, link FormLink, ref deliveryRef, cause error) int {
	permanent := errors.Is(cause, ErrPermanent)
	now := s.now()

	// Сутки подряд без успеха — связка считается сломанной, даже если каждый
	// отдельный отказ был временным.
	failingSince := link.FailingSince
	if failingSince.IsZero() {
		failingSince = now
	}
	reason := brokenReason(cause)
	if !permanent && now.Sub(failingSince) >= SheetBrokenAfter {
		permanent = true
		reason = "Google не принимает записи в эту таблицу больше суток — доставка остановлена. " +
			"Проверьте доступ к таблице и перезалейте лист."
	}

	if permanent {
		httpserver.LoggerFrom(ctx).Warn("integration marked broken",
			slog.String("link_id", link.ID.String()),
			slog.String("form_id", link.FormID.String()),
			slog.String("error", cause.Error()))
		s.breakLink(ctx, link, ref, reason)
		return 0
	}

	s.logDelivery(ctx, link.ID, ref, OutcomeFailed,
		"Записать в таблицу не удалось, попробуем ещё раз позже.", 0)
	next := now.Add(sheetBackoff(link.ConsecutiveFailures + 1))
	err := s.repo.MarkFailed(ctx, s.db, link.ID,
		"Записать в таблицу не удалось, попробуем ещё раз позже.", failingSince, next)
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("integration failure not stored",
			slog.String("link_id", link.ID.String()), slog.String("error", err.Error()))
	}
	return 0
}

// breakLink помечает связку сломанной: доставщик в неё больше не ходит, причина
// показана человеку. Строки очереди ОСТАЮТСЯ.
func (s *Service) breakLink(ctx context.Context, link FormLink, ref deliveryRef, reason string) {
	s.logDelivery(ctx, link.ID, ref, OutcomeFailed, reason, 0)
	if err := s.repo.MarkBroken(ctx, s.db, link.ID, reason); err != nil {
		httpserver.LoggerFrom(ctx).Error("integration broken mark not stored",
			slog.String("link_id", link.ID.String()), slog.String("error", err.Error()))
	}
	// Поломка молчаливая: доставщик ходит фоном, и без повода автор узнал бы о ней,
	// только заглянув на таб «Интеграции» нужной формы.
	s.noticeBroken(ctx, brokenTarget{
		workspaceID: link.WorkspaceID, formID: link.FormID, targetID: link.ID,
		kind: "sheet", name: link.Name,
		formName: link.FormName, formSlug: link.FormSlug, reason: reason,
	})
}

func sheetBackoff(failures int32) time.Duration {
	d := SheetBackoffBase
	for i := int32(1); i < failures; i++ {
		d *= 2
		if d >= SheetBackoffMax {
			return SheetBackoffMax
		}
	}
	return d
}

// CleanupSheetQueue снимает ответы, прождавшие дольше срока хранения, и
// оставляет по каждому строку в журнале: «не доставлен» — это исход, а не
// отсутствие записи. Зовётся периодической задачей.
func (s *Service) CleanupSheetQueue(ctx context.Context) (int64, error) {
	if !s.Enabled() {
		return 0, nil
	}
	border := s.now().Add(-SheetQueueTTL)
	expired, err := s.repo.ExpiredSheetQueued(ctx, s.db, border, sheetCleanupBatch)
	if err != nil {
		return 0, err
	}
	var n int64
	for _, ref := range expired {
		if ctx.Err() != nil {
			return n, nil
		}
		// Граница та же, по которой строку признали просроченной: перезалив,
		// успевший поставить этот ответ заново, её переживёт.
		if err := s.repo.DropSheetQueued(ctx, s.db, ref.LinkID, []uuid.UUID{ref.SubmissionID}, border); err != nil {
			return n, err
		}
		s.logDelivery(ctx, ref.LinkID, deliveryRef{kind: DeliveryKindSubmission, submissionID: ref.SubmissionID},
			OutcomeFailed, "Ответ так и не удалось доставить за 30 дней — доставка отменена.", 0)
		n++
	}
	return n, nil
}

// deliveryRef — предмет попытки: что именно везли. Журналу он нужен (лента
// показывает, за каким ответом ходили), доставке — нет, поэтому он ездит рядом с
// link, а не внутри неё.
type deliveryRef struct {
	kind         string
	submissionID uuid.UUID
}

// refOfQueued читает предмет из САМОЙ строки очереди, а не подразумевает живой
// ответ.
//
// ⚠ Мина: у строки переноса вид записи — backfill, и `SubmissionID` обязан
// остаться нулевым: запись с видом `submission` и пустым ответом отвергается
// схемой (CHECK `integration_deliveries_subject`), а отказ записи доставку не
// роняет (см. `logDelivery`) — значит, ошибка была бы тихой. У переноса,
// погасшего на сломанной связке, в ленте просто не появлялось бы строки. Ровно
// той, ради которой журнал и открывают.
func refOfQueued(q QueuedSheetRow) deliveryRef {
	if q.Backfill {
		return deliveryRef{kind: DeliveryKindBackfill}
	}
	return deliveryRef{kind: DeliveryKindSubmission, submissionID: q.SubmissionID}
}

// logDelivery пишет попытку в журнал (docs/INTEGRATIONS.md §12).
//
// ⚠ Мина: отказ ЗАПИСИ В ЖУРНАЛ не имеет права уронить доставку — поэтому у
// метода нет возвращаемой ошибки. Верните её наверх, и успешно уехавшая пачка
// отправится на ретрай, а `values.append` идемпотентности не знает: те же строки
// лягут в чужой лист вторым разом ради записи в наш журнал.
//
// Ошибки нашей же БД на пути доставки (аккаунт не читается, строки не
// собираются) сюда не попадают вовсе: это отказ не доставки, а нас самих, и его
// место в логе процесса, а не в ленте у автора формы.
func (s *Service) logDelivery(ctx context.Context, linkID uuid.UUID, ref deliveryRef, outcome, detail string, rows int32) {
	err := s.repo.InsertDelivery(ctx, s.db, Delivery{
		ID:           domain.NewID(),
		LinkID:       linkID,
		Kind:         ref.kind,
		SubmissionID: ref.submissionID,
		Outcome:      outcome,
		Detail:       detail,
		RowCount:     rows,
	})
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("integration delivery log write failed",
			slog.String("link_id", linkID.String()),
			slog.String("error", err.Error()))
	}
}

// brokenReason — человеческий текст причины для кабинета. Текст ошибки
// провайдера туда не уходит: он на английском и про HTTP, а читать его будет
// автор формы.
func brokenReason(cause error) string {
	// Текст называет ПРИЧИНУ и на этом кончается: что можно сделать, перечисляет
	// сам экран списком выходов, и дублировать их здесь значит однажды разойтись
	// с ним. Совет внутри причины к тому же не влезает в тултип строки списка,
	// где та же причина показывается целиком.
	if errors.Is(cause, ErrSheetNoRoom) {
		return "В форме появился новый вопрос, а справа в листе стоит ваша собственная колонка — " +
			"дописать заголовок некуда, не сдвинув её."
	}
	if errors.Is(cause, ErrSheetLayout) {
		return "Колонки листа больше не совпадают с вопросами формы — похоже, шапку правили вручную."
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

// ErrSheetNoRoom — новую колонку вопроса некуда дописать: справа от наших стоит
// колонка автора. Отдельно от ErrSheetLayout, хотя и вложен в него: причина
// другая и лечение другое, а один общий текст на оба случая советовал бы автору
// «вернуть шапку как было», то есть удалить свою же колонку.
var ErrSheetNoRoom = fmt.Errorf("%w: справа от наших колонок стоит чужая", ErrSheetLayout)

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
		return nil, fmt.Errorf("%w: ширина шапки %d при %d наших колонках", ErrSheetNoRoom, len(header), len(layout))
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
//
// form — колонки в порядке ФОРМЫ (в этом же порядке лежат values), columns — в
// порядке листа.
func alignRow(columns, form []domain.SheetColumn, values []string) []string {
	byKey := make(map[string]string, len(form))
	for i, c := range form {
		if i < len(values) {
			byKey[c.Key] = values[i]
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
