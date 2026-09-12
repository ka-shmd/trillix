package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/safehttp"
)

// ДОСТАВКА В ВЕБХУКИ (фаза 28 `DEV-PLAN`, спека §6, ADR §10).
//
// Очередь разобрана ПО ЦЕЛЯМ, а не по событиям: если адрес лежит, он лежит для
// всех ответов разом, поэтому расписание (пауза, поломка) живёт у цели, а строка
// очереди — просто «этот ответ ещё не доставлен сюда». Отсюда три следствия:
//
//   - мёртвый адрес получает ОДНУ попытку за окно бэкоффа, сколько бы ответов ни
//     ждало (в очереди писем было бы по попытке на каждое);
//   - ответы одной цели уходят по порядку — внутри цели доставка идёт по одному
//     запросу за раз;
//   - цели разбираются параллельно, и медленный получатель занимает один слот,
//     а не тик.
//
// Почта этого доставщика не видит вовсе: у неё свой диспетчер (internal/mail).

const (
	// WebhookTickTargets — сколько целей берётся за один проход.
	WebhookTickTargets = 20
	// WebhookBatchPerTarget — сколько ответов увозится у одной цели за проход.
	// Потолок нужен, чтобы цель с длинной очередью не держала слот весь тик:
	// остаток уедет следующим проходом, они идут каждые несколько секунд.
	//
	// Десять, а не двадцать: таймаут запроса поднят вдвое (safehttp.DefaultTimeout),
	// и произведение «пачка × таймаут» — то самое время, на которое медленный
	// получатель занимает слот, — осталось прежним.
	WebhookBatchPerTarget = 10
	// WebhookConcurrency — сколько целей разбирается одновременно. Одна цель —
	// один слот: порядок внутри неё этим и держится.
	WebhookConcurrency = 4
	// WebhookBackoffBase и WebhookBackoffMax — пауза ЦЕЛИ после неудачи: первая
	// неудача — минута, дальше удвоение до часа.
	WebhookBackoffBase = time.Minute
	WebhookBackoffMax  = time.Hour
	// WebhookBrokenAfter — сколько цель может не принимать подряд, прежде чем
	// считается сломанной. Сутки: столько живёт большинство аварий у получателя,
	// после чего стучаться в него бессмысленно, а ответы копятся до починки.
	WebhookBrokenAfter = 24 * time.Hour
	// WebhookQueueTTL — сколько ответ ждёт доставки. Тот же срок, что у журнала:
	// починили адрес в пределах месяца — получите всё накопленное.
	WebhookQueueTTL = DeliveryTTL
	// webhookCleanupBatch — сколько просроченных строк снимается за проход.
	webhookCleanupBatch = 500
	// webhookUserAgent — по нему получатель узнаёт наши запросы в своих логах.
	webhookUserAgent = "Trillix-Webhooks/1.0"
)

// errSecretUnreadable — секрет подписи не открывается ключом контура (ротация
// FORM_TOKEN_SECRET). Подписать запрос нечем, и сама собой беда не пройдёт.
var errSecretUnreadable = errors.New("integrations: секрет подписи вебхука не читается")

// webhookStep — исход одной попытки для цикла по цели.
type webhookStep int

const (
	stepDelivered webhookStep = iota // ответ уехал — идём к следующему
	stepSkipped                      // везти нечего — идём к следующему
	stepStop                         // цель уснула или сломалась — её проход кончен
)

// DeliverWebhooks отвозит одну пачку: цели, которым есть что везти и чьё время
// наступило. Возвращает число уехавших ответов. Зовётся периодической задачей.
func (s *Service) DeliverWebhooks(ctx context.Context) (int, error) {
	if s.webhooks == nil || s.egress == nil || s.submissions == nil {
		return 0, nil
	}
	targets, err := s.webhooks.DueWebhooks(ctx, s.db, WebhookTickTargets)
	if err != nil {
		return 0, err
	}

	var (
		sent atomic.Int64
		wg   sync.WaitGroup
		slot = make(chan struct{}, WebhookConcurrency)
	)
	for _, w := range targets {
		if ctx.Err() != nil {
			break // остановка процесса — не ошибка задачи
		}
		wg.Add(1)
		go func(w Webhook) {
			defer wg.Done()
			slot <- struct{}{}
			defer func() { <-slot }()
			sent.Add(int64(s.deliverWebhook(ctx, w)))
		}(w)
	}
	wg.Wait()
	return int(sent.Load()), nil
}

// deliverWebhook увозит ответы ОДНОЙ цели — по одному запросу за раз, в порядке
// постановки. Первая же неудача заканчивает её проход: цель уснула, и остальные
// её ответы ждут следующего окна, а не добавляют запросов в лежащий адрес.
func (s *Service) deliverWebhook(ctx context.Context, w Webhook) int {
	ids, err := s.webhooks.PendingSubmissions(ctx, s.db, w.ID, WebhookBatchPerTarget)
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("webhook queue not read",
			slog.String("webhook_id", w.ID.String()), slog.String("error", err.Error()))
		return 0
	}
	sent := 0
	for _, submissionID := range ids {
		if ctx.Err() != nil {
			return sent
		}
		switch s.deliverToWebhook(ctx, w, submissionID) {
		case stepDelivered:
			sent++
		case stepSkipped:
		case stepStop:
			return sent
		}
	}
	return sent
}

// deliverToWebhook — одна попытка: сторож членства, сборка тела, запрос, исход.
func (s *Service) deliverToWebhook(ctx context.Context, w Webhook, submissionID uuid.UUID) webhookStep {
	// Тот, кто ПОСЛЕДНИМ задал адрес, всё ещё участник пространства формы?
	//
	// Без этого сторожа редактор, поставивший вебхук на свой сервер, продолжал бы
	// получать ответы после снятия доступа. У связки Таблиц ту же дыру закрывает
	// личный аккаунт Google; у вебхука личного ничего нет, поэтому отвечает тот,
	// кто решил, куда едут ответы (спека §9).
	member := false
	if w.SetBy != uuid.Nil {
		ok, err := s.access.IsMember(ctx, w.WorkspaceID, w.SetBy)
		if err != nil {
			httpserver.LoggerFrom(ctx).Error("webhook membership not checked",
				slog.String("webhook_id", w.ID.String()), slog.String("error", err.Error()))
			return stepStop
		}
		member = ok
	}
	if !member {
		return s.breakWebhook(ctx, w, submissionID, 0,
			"Адрес задал участник, у которого больше нет доступа к пространству. "+
				"Сохраните адрес заново, чтобы доставка продолжилась.")
	}

	rec, err := s.submissions.WebhookRow(ctx, w.FormID, submissionID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Ответ удалён автором или скрыт тарифом (over_quota) — доставлять нечего.
		s.dropQueued(ctx, w.ID, submissionID)
		s.logWebhookDelivery(ctx, w.ID, submissionID, OutcomeSkipped,
			"Ответ удалён или скрыт лимитом тарифа — отправлять было нечего.", 0)
		return stepSkipped
	}
	if err != nil {
		// Беда НАША, а не получателя: цель за неё усыплять нельзя, и в ленту
		// автора это не попадает — его вины тут нет. Попробуем следующим проходом.
		httpserver.LoggerFrom(ctx).Error("webhook payload not built",
			slog.String("webhook_id", w.ID.String()), slog.String("error", err.Error()))
		return stepStop
	}

	body, err := json.Marshal(domain.WebhookPayload{
		Version: domain.WebhookPayloadVersion,
		Event:   domain.WebhookEventSubmission,
		Form:    domain.WebhookForm{ID: w.FormID.String(), Title: rec.FormTitle},
		Submission: domain.WebhookSubmission{
			ID:          submissionID.String(),
			SubmittedAt: rec.CreatedAt.UTC().Format(time.RFC3339),
			FormVersion: rec.FormVersion,
			Fields:      rec.Fields,
		},
	})
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("webhook payload not marshalled",
			slog.String("webhook_id", w.ID.String()), slog.String("error", err.Error()))
		return stepStop
	}

	resp, err := s.sendWebhook(ctx, w, body)
	if err == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		s.dropQueued(ctx, w.ID, submissionID)
		s.logWebhookDelivery(ctx, w.ID, submissionID, OutcomeDelivered, "", int32(resp.StatusCode))
		if err := s.webhooks.MarkWebhookDelivered(ctx, s.db, w.ID); err != nil {
			httpserver.LoggerFrom(ctx).Error("webhook success not stored",
				slog.String("webhook_id", w.ID.String()), slog.String("error", err.Error()))
		}
		return stepDelivered
	}
	return s.webhookFailed(ctx, w, submissionID, resp.StatusCode, err)
}

// sendWebhook отправляет тело и, если подпись включена, подписывает его. Секрет
// открывается здесь — ЕДИНСТВЕННОЕ место расшифровки на пути доставки.
//
// Подписи у вебхука может не быть вовсе (0063, ADR §10): тогда заголовка не
// появляется, и это штатное умолчание, а не сбой.
func (s *Service) sendWebhook(ctx context.Context, w Webhook, body []byte) (resp safehttp.Response, err error) {
	header := http.Header{}
	header.Set("Content-Type", "application/json; charset=utf-8")
	header.Set("User-Agent", webhookUserAgent)
	if len(w.SecretSealed) > 0 {
		secret, err := openWebhookSecret(s.key, w.SecretSealed)
		if err != nil {
			return safehttp.Response{}, errSecretUnreadable
		}
		header.Set(domain.WebhookSignatureHeader, domain.SignWebhook(secret, s.now(), body))
	}
	return s.egress.Post(ctx, w.URL, header, body)
}

// webhookFailed разбирает неудачу: окончательная ломает цель, временная
// усыпляет её до следующего окна. Обе пишутся в журнал — для автора разница
// между «поедет позже» и «больше не поедет» это разница между «ждать» и
// «идти чинить».
func (s *Service) webhookFailed(ctx context.Context, w Webhook, submissionID uuid.UUID, code int, cause error) webhookStep {
	permanent, reason := webhookFailureReason(code, cause)
	now := s.now()

	// Сутки подряд без успеха — цель считается сломанной, даже если каждый
	// отдельный отказ был временным. Отсчёт идёт от ПЕРВОЙ неудачи подряд.
	failingSince := w.FailingSince
	if failingSince.IsZero() {
		failingSince = now
	}
	if !permanent && now.Sub(failingSince) >= WebhookBrokenAfter {
		permanent = true
		reason = "Адрес не принимает запросы больше суток — доставка остановлена. " +
			"Проверьте адрес и нажмите «Проверить»."
	}

	if cause != nil {
		// Полный текст отказа — в лог: он на английском и про сеть, а читает
		// журнал автор формы. Адреса в нём нет (safehttp.Post его не печатает).
		httpserver.LoggerFrom(ctx).Warn("webhook delivery failed",
			slog.String("webhook_id", w.ID.String()),
			slog.String("host", w.Host),
			slog.Bool("permanent", permanent),
			slog.String("error", cause.Error()))
	}
	if permanent {
		return s.breakWebhook(ctx, w, submissionID, int32(code), reason)
	}

	s.logWebhookDelivery(ctx, w.ID, submissionID, OutcomeFailed, reason, int32(code))
	next := now.Add(webhookBackoff(w.ConsecutiveFailures + 1))
	if err := s.webhooks.MarkWebhookFailed(ctx, s.db, w.ID, reason, failingSince, next); err != nil {
		httpserver.LoggerFrom(ctx).Error("webhook failure not stored",
			slog.String("webhook_id", w.ID.String()), slog.String("error", err.Error()))
	}
	return stepStop
}

// breakWebhook помечает цель сломанной. Строка очереди ОСТАЁТСЯ: ответы копятся,
// и починка увезёт их по порядку — в этом разница с погашенным событием очереди
// писем, которое вернуть было бы нечем.
func (s *Service) breakWebhook(ctx context.Context, w Webhook, submissionID uuid.UUID, code int32, reason string) webhookStep {
	s.logWebhookDelivery(ctx, w.ID, submissionID, OutcomeFailed, reason, code)
	httpserver.LoggerFrom(ctx).Warn("webhook marked broken",
		slog.String("webhook_id", w.ID.String()), slog.String("host", w.Host))
	if err := s.webhooks.MarkWebhookBroken(ctx, s.db, w.ID, reason); err != nil {
		httpserver.LoggerFrom(ctx).Error("webhook broken mark not stored",
			slog.String("webhook_id", w.ID.String()), slog.String("error", err.Error()))
	}
	return stepStop
}

// webhookFailureReason — человеческая причина и приговор: чинить или ждать.
// Текст РУССКИЙ и наш: ответ получателя на экран не попадает ни в каком виде.
func webhookFailureReason(code int, cause error) (permanent bool, reason string) {
	if errors.Is(cause, errSecretUnreadable) {
		return true, "Секрет подписи больше не читается — задайте его заново в настройках вебхука."
	}
	if cause != nil {
		switch safehttp.Classify(cause) {
		case safehttp.FailureForbidden:
			return true, "Адрес ведёт во внутреннюю сеть — туда ответы не отправляются."
		case safehttp.FailureInvalidURL:
			return true, "Адрес больше не годится для отправки — задайте его заново."
		case safehttp.FailureTimeout:
			return false, "Получатель не ответил за десять секунд, попробуем ещё раз позже."
		case safehttp.FailureNotFound:
			return false, "Сервер с таким адресом не найден, попробуем ещё раз позже."
		case safehttp.FailureTLS:
			return false, "Сертификат получателя не прошёл проверку, попробуем ещё раз позже."
		case safehttp.FailureRefused:
			return false, "Получатель отклонил соединение, попробуем ещё раз позже."
		default:
			return false, "Не удалось отправить запрос, попробуем ещё раз позже."
		}
	}
	switch {
	case code == http.StatusGone:
		// Так отписывается Zapier, когда хук удалён: адрес больше не существует.
		return true, "Получатель сообщил, что этого адреса больше нет (код 410)."
	case code >= 300 && code < 400:
		return false, "Адрес перенаправляет запрос — укажите конечный адрес."
	default:
		return false, fmt.Sprintf("Получатель ответил кодом %d, попробуем ещё раз позже.", code)
	}
}

// webhookBackoff — пауза цели перед следующей попыткой: удвоение от базы до
// потолка. Та же модель, что у очереди писем, только считается у ЦЕЛИ.
func webhookBackoff(failures int32) time.Duration {
	d := WebhookBackoffBase
	for i := int32(1); i < failures; i++ {
		d *= 2
		if d >= WebhookBackoffMax {
			return WebhookBackoffMax
		}
	}
	return d
}

// dropQueued снимает ответ с очереди. Неудача снятия не роняет доставку: строка
// уедет второй раз, а получатель дедуплицирует её по id ответа (контракт §7).
func (s *Service) dropQueued(ctx context.Context, webhookID, submissionID uuid.UUID) {
	if err := s.webhooks.Dequeue(ctx, s.db, webhookID, submissionID); err != nil {
		httpserver.LoggerFrom(ctx).Error("webhook queue row not removed",
			slog.String("webhook_id", webhookID.String()), slog.String("error", err.Error()))
	}
}

// logWebhookDelivery пишет попытку в журнал.
//
// ⚠ Мина: отказ ЗАПИСИ В ЖУРНАЛ не имеет права уронить доставку — поэтому у
// метода нет возвращаемой ошибки (тот же довод, что у logDelivery связки).
func (s *Service) logWebhookDelivery(ctx context.Context, webhookID, submissionID uuid.UUID, outcome, detail string, code int32) {
	err := s.webhooks.InsertWebhookDelivery(ctx, s.db, Delivery{
		ID:           domain.NewID(),
		WebhookID:    webhookID,
		Kind:         DeliveryKindSubmission,
		SubmissionID: submissionID,
		Outcome:      outcome,
		Detail:       detail,
		HTTPStatus:   code,
	})
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("webhook delivery log write failed",
			slog.String("webhook_id", webhookID.String()), slog.String("error", err.Error()))
	}
}

// CleanupWebhookQueue снимает ответы, прождавшие дольше срока хранения, и
// оставляет по каждому строку в журнале: «не доставлен» — это исход, а не
// отсутствие записи. Зовётся периодической задачей.
func (s *Service) CleanupWebhookQueue(ctx context.Context) (int64, error) {
	if s.webhooks == nil {
		return 0, nil
	}
	expired, err := s.webhooks.ExpiredQueued(ctx, s.db, s.now().Add(-WebhookQueueTTL), webhookCleanupBatch)
	if err != nil {
		return 0, err
	}
	var n int64
	for _, ref := range expired {
		if ctx.Err() != nil {
			return n, nil
		}
		if err := s.webhooks.Dequeue(ctx, s.db, ref.WebhookID, ref.SubmissionID); err != nil {
			return n, err
		}
		s.logWebhookDelivery(ctx, ref.WebhookID, ref.SubmissionID, OutcomeFailed,
			"Ответ так и не удалось доставить за 30 дней — доставка отменена.", 0)
		n++
	}
	return n, nil
}

// WebhookDeliveries — страница журнала вебхука, новые сверху.
//
// Право — form.write, как у ленты связки Таблиц: журнал раскрывает коды ответов
// и причины отказов получателя, и это не то, что показывают всякому, кто вправе
// открыть форму.
func (s *Service) WebhookDeliveries(ctx context.Context, userID, formID, webhookID, cursor uuid.UUID) ([]Delivery, error) {
	if s.webhooks == nil {
		return nil, domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return nil, err
	}
	w, err := s.webhookOfForm(ctx, formID, webhookID)
	if err != nil {
		return nil, err
	}
	return s.webhooks.ListWebhookDeliveries(ctx, s.db, w.ID, cursor, DeliveryPageSize)
}

// RetryWebhookDelivery ставит ответ в очередь заново — через те же проверки, что
// живая доставка. Своего пути мимо них у повтора нет.
//
// ⚠ Отказ на СЛОМАННОЙ цели намеренный: доставщик в неё не ходит вовсе, и кнопка
// молча ничего не дала бы. Сначала лечение — «Проверить» или новый адрес.
func (s *Service) RetryWebhookDelivery(ctx context.Context, userID, formID, webhookID, deliveryID uuid.UUID) error {
	if s.webhooks == nil {
		return domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	w, err := s.webhookOfForm(ctx, formID, webhookID)
	if err != nil {
		return err
	}
	d, err := s.webhooks.GetWebhookDelivery(ctx, s.db, deliveryID, w.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return err
	}
	if d.SubmissionID == uuid.Nil {
		return fmt.Errorf("%w: повторить можно только доставку одного ответа", domain.ErrValidation)
	}
	// Спрашивается судьба ОТВЕТА, а не исход строки, по которой нажали: строка =
	// одна попытка, и у ответа, доехавшего со второго раза, первая навсегда
	// остаётся неудачной.
	delivered, err := s.webhooks.WebhookSubmissionDelivered(ctx, s.db, w.ID, d.SubmissionID)
	if err != nil {
		return err
	}
	if delivered {
		return fmt.Errorf("%w: этот ответ уже доставлен", domain.ErrValidation)
	}
	if w.Status == StatusBroken {
		return fmt.Errorf("%w: сначала почините адрес — проверка вернёт вебхук в работу", domain.ErrConflict)
	}
	return s.webhooks.Enqueue(ctx, s.db, w.ID, d.SubmissionID)
}

// WebhookTestResult — исход проверки адреса кнопкой.
type WebhookTestResult struct {
	// OK — получатель ответил успехом (2xx).
	OK         bool
	StatusCode int
	// Reason — человеческая причина неуспеха; у успеха пусто.
	Reason  string
	Elapsed time.Duration
}

// TestWebhook шлёт получателю ОБРАЗЕЦ — те же вопросы формы с примерными
// значениями и пометкой test. Настоящий ответ для этого не берётся: получатель,
// который дедуплицирует по id, потом отбросил бы его живую доставку.
//
// Успех возвращает сломанную цель в работу: это и есть кнопка починки.
func (s *Service) TestWebhook(ctx context.Context, userID, formID, webhookID uuid.UUID) (WebhookTestResult, error) {
	if s.webhooks == nil || s.egress == nil {
		return WebhookTestResult{}, domain.ErrNotFound
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return WebhookTestResult{}, err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return WebhookTestResult{}, err
	}
	w, err := s.webhookOfForm(ctx, formID, webhookID)
	if err != nil {
		return WebhookTestResult{}, err
	}
	builder, err := s.columnModel(ctx, userID, formID)
	if err != nil {
		return WebhookTestResult{}, err
	}

	body, err := json.Marshal(domain.WebhookPayload{
		Version: domain.WebhookPayloadVersion,
		Event:   domain.WebhookEventSubmission,
		Test:    true,
		Form:    domain.WebhookForm{ID: formID.String(), Title: form.Title},
		Submission: domain.WebhookSubmission{
			ID:          domain.NewID().String(),
			SubmittedAt: s.now().UTC().Format(time.RFC3339),
			FormVersion: 1,
			Fields:      builder.WebhookSampleFields(),
		},
	})
	if err != nil {
		return WebhookTestResult{}, fmt.Errorf("marshal webhook sample: %w", err)
	}

	resp, err := s.sendWebhook(ctx, w, body)
	if err == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// Удачная проверка означает «получатель работает СЕЙЧАС», поэтому будит
		// цель в обоих состояниях: и сломанную, и просто спящую после неудачи.
		// Иначе человек чинит получателя, видит «ответил 200» — и ждёт конца
		// бэкоффа, не понимая, почему очередь стоит.
		if err := s.webhooks.ReviveWebhook(ctx, s.db, w.ID); err != nil {
			return WebhookTestResult{}, err
		}
		return WebhookTestResult{OK: true, StatusCode: resp.StatusCode, Elapsed: resp.Duration}, nil
	}
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("webhook test failed",
			slog.String("webhook_id", w.ID.String()), slog.String("host", w.Host),
			slog.String("error", err.Error()))
	}
	_, reason := webhookFailureReason(resp.StatusCode, err)
	return WebhookTestResult{StatusCode: resp.StatusCode, Reason: reason, Elapsed: resp.Duration}, nil
}
