package integrations

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/safehttp"
)

// ВЕБХУКИ (фаза 28 `DEV-PLAN`, спека docs/design/webhooks.md, ADR §10) — второй
// вид цели доставки рядом со связкой Google Таблиц. Здесь — управление: завести,
// править, показать и перевыпустить секрет, удалить. Статусы — те же StatusLive
// и StatusBroken, что у связки (CHECK form_webhooks_status_check).

// MaxWebhooksPerForm — потолок вебхуков на форму: без него одна отправка формы
// превращается в N запросов с нашего IP (спека §9).
const MaxWebhooksPerForm = 5

// webhookSecretPrefix — по префиксу секрет узнаётся глазами и сканерами утечек.
// Только у НАШЕГО секрета: чужой мы не переписываем.
const webhookSecretPrefix = "whsec_"

// MinWebhookSecretLen — минимум для секрета, заданного автором. Свой секрет
// разрешён ради одного секрета на все формы (ADR §10), но «123456» обесценивает
// подпись целиком: подделать запрос смог бы любой. Наш собственный секрет длиннее
// вчетверо, и планка касается только введённого руками.
const MinWebhookSecretLen = 16

// MaxWebhookSecretLen — потолок: секрет едет ключом HMAC, и мегабайт в этом поле
// не означает ничего, кроме промаха при вставке.
const MaxWebhookSecretLen = 200

// Webhook — вебхук формы, как он лежит у нас.
//
// SecretSealed — ШИФРОТЕКСТ и остаётся им везде выше repo, как refresh-токен у
// Connection. Мина: добавите его в ответ API — отдадите наружу ключ подписи.
// URL — тоже секрет (токен Zapier и Make лежит в пути): в состоянии таба он пуст
// у того, кто не вправе править форму (FormStatus), в лог уходит только Host.
type Webhook struct {
	ID     uuid.UUID
	FormID uuid.UUID
	Name   string
	URL    string
	// Host — хост адреса, выведенный при чтении: его видят все, кто видит форму.
	Host string
	// SecretSealed — секрет подписи шифротекстом. ПУСТО = подпись выключена
	// (0063): заголовка в запросе не появляется, и на экране о секрете нет ни
	// одного поля. Это умолчание.
	SecretSealed []byte
	// SetBy — кто последним задал адрес; нулевой — его аккаунт удалён, и
	// отвечать за доставку некому.
	SetBy           uuid.UUID
	Enabled         bool
	Status          string
	LastError       string
	LastDeliveredAt time.Time
	// Queued — сколько ответов ждут доставки.
	Queued    int64
	CreatedAt time.Time

	// Дальше — то, что нужно ДОСТАВЩИКУ и не нужно экрану; у чтений для таба
	// эти поля пусты.
	//
	// WorkspaceID — пространство формы: по нему сторож спрашивает членство SetBy.
	WorkspaceID uuid.UUID
	// FailingSince — с какого момента цель подряд не принимает. Сутки — поломка;
	// момент ПЕРВОГО отказа, а не последнего, иначе отсчёт не наступит никогда.
	FailingSince time.Time
	// ConsecutiveFailures — сколько неудач подряд: по нему считается бэкофф цели.
	ConsecutiveFailures int32
	NextAttemptAt       time.Time
}

// webhookHost — хост адреса: единственное, что о нём видит роль без права правки
// и что пишется в лог.
func webhookHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// NewWebhook — что записать при заведении вебхука.
type NewWebhook struct {
	ID           uuid.UUID
	FormID       uuid.UUID
	Name         string
	URL          string
	SecretSealed []byte
	SetBy        uuid.UUID
}

// WebhookStore — данные вебхуков. Отдельно от Store: у связок Таблиц своя
// жизнь и свои фейки в тестах, и вебхуку не нужно ни одного их метода.
// Реализация — Repo.
type WebhookStore interface {
	// InsertWebhook заводит вебхук, если у формы их меньше maxPerForm; false —
	// потолок достигнут.
	InsertWebhook(ctx context.Context, db postgres.DBTX, w NewWebhook, maxPerForm int32) (bool, error)
	ListWebhooks(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]Webhook, error)
	GetWebhook(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (Webhook, error)
	UpdateWebhookSettings(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, name string, enabled bool) (int64, error)
	UpdateWebhookURL(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, rawURL string, setBy uuid.UUID) (int64, error)
	UpdateWebhookSecret(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, sealed []byte) (int64, error)
	ClearWebhookSecret(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
	DeleteWebhook(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
	ClearWebhookQueue(ctx context.Context, db postgres.DBTX, id uuid.UUID) error

	// Доставка (webhook_delivery.go).
	DueWebhooks(ctx context.Context, db postgres.DBTX, limit int32) ([]Webhook, error)
	PendingSubmissions(ctx context.Context, db postgres.DBTX, webhookID uuid.UUID, limit int32) ([]uuid.UUID, error)
	Dequeue(ctx context.Context, db postgres.DBTX, webhookID, submissionID uuid.UUID) error
	Enqueue(ctx context.Context, db postgres.DBTX, webhookID, submissionID uuid.UUID) error
	ExpiredQueued(ctx context.Context, db postgres.DBTX, before time.Time, limit int32) ([]QueuedRef, error)
	MarkWebhookDelivered(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	MarkWebhookFailed(ctx context.Context, db postgres.DBTX, id uuid.UUID, reason string, failingSince, nextAttemptAt time.Time) error
	MarkWebhookBroken(ctx context.Context, db postgres.DBTX, id uuid.UUID, reason string) error
	ReviveWebhook(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	InsertWebhookDelivery(ctx context.Context, db postgres.DBTX, d Delivery) error
	ListWebhookDeliveries(ctx context.Context, db postgres.DBTX, webhookID, cursor uuid.UUID, limit int32) ([]Delivery, error)
	GetWebhookDelivery(ctx context.Context, db postgres.DBTX, id, webhookID uuid.UUID) (Delivery, error)
	WebhookSubmissionDelivered(ctx context.Context, db postgres.DBTX, webhookID, submissionID uuid.UUID) (bool, error)
}

// QueuedRef — строка очереди: какой ответ в какую цель.
type QueuedRef struct {
	WebhookID    uuid.UUID
	SubmissionID uuid.UUID
}

var _ WebhookStore = Repo{}

// Egress — исходящий HTTP по адресу пользователя (internal/safehttp).
type Egress interface {
	Validate(ctx context.Context, raw string) (*url.URL, error)
	Post(ctx context.Context, rawURL string, header http.Header, body []byte) (safehttp.Response, error)
}

// WithWebhooks подключает вебхуки. Отдельным сеттером, а не аргументом
// конструктора: вебхуки не зависят от ключей Google, и сборка без провайдера
// Таблиц (dev-контур без проекта в Google Cloud) обязана их иметь.
//
// now — часы доставки (бэкофф цели и сутки до поломки). Параметром, как у
// entitlements: тест с подменёнными часами не должен ждать реальных суток.
// nil = time.Now.
func (s *Service) WithWebhooks(store WebhookStore, egress Egress, now func() time.Time) *Service {
	s.webhooks, s.egress = store, egress
	if now != nil {
		s.now = now
	}
	return s
}

// WebhookInput — то, что человек ввёл в окне вебхука при заведении.
type WebhookInput struct {
	Name string
	URL  string
	// Secret — секрет подписи автора. Пусто = вебхук заводится БЕЗ подписи:
	// подключение это адрес и всё, а подпись включается потом тумблером в
	// настройках (ADR §10, третий круг).
	Secret string
}

// WebhookPatch — правка вебхука. nil — поле не трогается: тумблер из списка шлёт
// только enabled, и правка подписи не должна исподтишка что-то выключать.
type WebhookPatch struct {
	Name    *string
	Enabled *bool
	// URL, переданный даже тем же, делает правящего ответственным за доставку и
	// снимает поломку (спека §9).
	URL *string
}

// CreateWebhook заводит вебхук формы и отдаёт его вместе с секретом подписи в
// открытом виде — показать сразу после заведения.
//
// Адрес проверяется ПОСЛЕ права на форму: проверка резолвит имя, и постороннему
// нельзя давать пользоваться нами как DNS-оракулом.
func (s *Service) CreateWebhook(ctx context.Context, userID, formID uuid.UUID, in WebhookInput) (Webhook, string, error) {
	if s.webhooks == nil {
		return Webhook{}, "", domain.ErrNotFound
	}
	name, err := webhookName(in.Name)
	if err != nil {
		return Webhook{}, "", err
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return Webhook{}, "", err
	}
	rawURL, err := s.checkWebhookURL(ctx, in.URL)
	if err != nil {
		return Webhook{}, "", err
	}
	// Подписи по умолчанию нет: секрет заводится, только если автор назвал свой.
	var secret string
	var sealed []byte
	if strings.TrimSpace(in.Secret) != "" {
		if secret, sealed, err = s.sealedSecret(in.Secret); err != nil {
			return Webhook{}, "", err
		}
	}

	w := NewWebhook{
		ID:           domain.NewID(),
		FormID:       formID,
		Name:         name,
		URL:          rawURL,
		SecretSealed: sealed,
		SetBy:        userID,
	}
	ok, err := s.webhooks.InsertWebhook(ctx, s.db, w, MaxWebhooksPerForm)
	if err != nil {
		return Webhook{}, "", err
	}
	if !ok {
		return Webhook{}, "", fmt.Errorf("%w: у формы уже %d вебхуков — больше завести нельзя",
			domain.ErrValidation, MaxWebhooksPerForm)
	}
	return Webhook{
		ID:           w.ID,
		FormID:       formID,
		Name:         name,
		URL:          rawURL,
		Host:         webhookHost(rawURL),
		SecretSealed: sealed,
		SetBy:        userID,
		Enabled:      true,
		Status:       StatusLive,
		CreatedAt:    time.Now().UTC(),
	}, secret, nil
}

// UpdateWebhook правит подпись, тумблер и адрес.
//
// Всё — одной транзакцией: выключение и снятие очереди — одно намерение («не
// доставлять»), и между ними не должно быть момента, когда выключенный вебхук
// ещё держит ответы, которые включение вывалило бы разом.
func (s *Service) UpdateWebhook(ctx context.Context, userID, formID, webhookID uuid.UUID, patch WebhookPatch) error {
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
	// Всё разбирается ДО первой записи: правка с негодным адресом не должна
	// успеть сохранить подпись.
	name, enabled := w.Name, w.Enabled
	if patch.Name != nil {
		if name, err = webhookName(*patch.Name); err != nil {
			return err
		}
	}
	if patch.Enabled != nil {
		enabled = *patch.Enabled
	}
	var rawURL string
	if patch.URL != nil {
		if rawURL, err = s.checkWebhookURL(ctx, *patch.URL); err != nil {
			return err
		}
	}

	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if patch.Name != nil || patch.Enabled != nil {
			n, err := s.webhooks.UpdateWebhookSettings(ctx, tx, w.ID, formID, name, enabled)
			if err != nil {
				return err
			}
			if n == 0 {
				return domain.ErrNotFound
			}
			if !enabled {
				if err := s.webhooks.ClearWebhookQueue(ctx, tx, w.ID); err != nil {
					return err
				}
			}
		}
		if patch.URL != nil {
			n, err := s.webhooks.UpdateWebhookURL(ctx, tx, w.ID, formID, rawURL, userID)
			if err != nil {
				return err
			}
			if n == 0 {
				return domain.ErrNotFound
			}
		}
		return nil
	})
}

// WebhookSecret отдаёт секрет подписи в открытом виде — по нажатию «Показать».
// У вебхука без подписи секрета нет вовсе: это не ошибка, а его состояние, и
// отвечаем мы тем же, чем на несуществующее, — 404.
func (s *Service) WebhookSecret(ctx context.Context, userID, formID, webhookID uuid.UUID) (string, error) {
	if s.webhooks == nil {
		return "", domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return "", err
	}
	w, err := s.webhookOfForm(ctx, formID, webhookID)
	if err != nil {
		return "", err
	}
	if len(w.SecretSealed) == 0 {
		return "", domain.ErrNotFound
	}
	secret, err := openWebhookSecret(s.key, w.SecretSealed)
	if err != nil {
		// Шифротекст пережил ротацию FORM_TOKEN_SECRET: открыть его больше нечем.
		return "", fmt.Errorf("%w: секрет подписи больше не читается — перевыпустите его", domain.ErrConflict)
	}
	return secret, nil
}

// ReissueWebhookSecret ставит новый секрет подписи и отдаёт его. Старый перестаёт
// подходить сразу, без переходного окна (спека §7).
//
// custom пуст — секрет генерируем мы. Задан — берём авторский: у человека с
// двадцатью формами иначе двадцать разных секретов и двадцать записей в конфиге
// получателя (ADR §10, второй круг решений). Подпись при этом обязательна
// всегда: выключателя у неё нет.
func (s *Service) ReissueWebhookSecret(ctx context.Context, userID, formID, webhookID uuid.UUID, custom string) (string, error) {
	if s.webhooks == nil {
		return "", domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return "", err
	}
	secret, sealed, err := s.sealedSecret(custom)
	if err != nil {
		return "", err
	}
	n, err := s.webhooks.UpdateWebhookSecret(ctx, s.db, webhookID, formID, sealed)
	if err != nil {
		return "", err
	}
	if n == 0 {
		return "", domain.ErrNotFound
	}
	return secret, nil
}

// DisableWebhookSignature выключает подпись: секрет удаляется, и заголовок в
// запросах больше не появляется. Отдельным действием, а не «пустым секретом» в
// правке: выключение подписи — осознанный шаг, и спутать его с очисткой поля
// нельзя.
func (s *Service) DisableWebhookSignature(ctx context.Context, userID, formID, webhookID uuid.UUID) error {
	if s.webhooks == nil {
		return domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	n, err := s.webhooks.ClearWebhookSecret(ctx, s.db, webhookID, formID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// DeleteWebhook удаляет вебхук; его очередь и журнал уходят каскадом.
func (s *Service) DeleteWebhook(ctx context.Context, userID, formID, webhookID uuid.UUID) error {
	if s.webhooks == nil {
		return domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	// Ноль строк — вебхука нет либо он чужой формы: ответ на оба случая один
	// (инвариант 5).
	n, err := s.webhooks.DeleteWebhook(ctx, s.db, webhookID, formID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// listWebhooks — вебхуки формы для таба. Сборка без вебхуков отдаёт пустой
// список: это состояние экрана, а не ошибка.
//
// Кто не вправе править форму, получает вебхуки без адреса: в пути у Zapier и
// Make лежит токен получателя, и знать его незачем тому, кто не может ничего
// поменять (спека §9). Решение живёт здесь, а не в ручке: это вопрос права.
func (s *Service) listWebhooks(ctx context.Context, formID uuid.UUID, canEdit bool) ([]Webhook, error) {
	if s.webhooks == nil {
		return nil, nil
	}
	list, err := s.webhooks.ListWebhooks(ctx, s.db, formID)
	if err != nil {
		return nil, err
	}
	if !canEdit {
		for i := range list {
			list[i].URL = ""
		}
	}
	return list, nil
}

// webhookOfForm читает вебхук, убеждаясь, что он принадлежит названной форме: id
// приезжает из адреса и правом доступа не является (инвариант 1).
func (s *Service) webhookOfForm(ctx context.Context, formID, webhookID uuid.UUID) (Webhook, error) {
	w, err := s.webhooks.GetWebhook(ctx, s.db, webhookID, formID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Webhook{}, domain.ErrNotFound
	}
	if err != nil {
		return Webhook{}, err
	}
	return w, nil
}

// checkWebhookURL проверяет адрес при сохранении и отдаёт его в том виде, в
// каком он хранится. Это внятный отказ сразу; защита — при каждом соединении
// (internal/safehttp).
func (s *Service) checkWebhookURL(ctx context.Context, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("%w: укажите адрес, на который отправлять ответы", domain.ErrValidation)
	}
	if _, err := s.egress.Validate(ctx, raw); err != nil {
		return "", webhookURLError(err)
	}
	return raw, nil
}

// webhookURLError переводит отказ проверки адреса в человеческий текст. Что не
// распознано — не отказ адреса, а сбой, и уходит наверх как есть (500).
func webhookURLError(err error) error {
	var text string
	switch {
	case errors.Is(err, safehttp.ErrScheme):
		text = "адрес должен начинаться с https:// — по http ответы ушли бы незашифрованными"
	case errors.Is(err, safehttp.ErrUserInfo):
		text = "уберите логин и пароль из адреса — запросы подписываются секретом"
	case errors.Is(err, safehttp.ErrMalformed):
		text = "адрес не похож на ссылку — проверьте, что он скопирован целиком"
	case errors.Is(err, safehttp.ErrOwnHost):
		text = "это адрес самого Trillix — укажите адрес системы, которая примет ответы"
	case errors.Is(err, safehttp.ErrForbiddenAddress):
		text = "адрес ведёт во внутреннюю сеть — туда ответы не отправляются"
	case errors.Is(err, safehttp.ErrNotFound):
		text = "сервер с таким адресом не найден — проверьте имя"
	default:
		return err
	}
	return fmt.Errorf("%w: %s", domain.ErrValidation, text)
}

// webhookName — подпись вебхука после обрезки пробелов. Ввод валидируется на бэке
// независимо от фронта (инвариант 3).
func webhookName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if utf8.RuneCountInString(name) > MaxConnectionNameLen {
		return "", fmt.Errorf("%w: название длиннее %d символов", domain.ErrValidation, MaxConnectionNameLen)
	}
	return name, nil
}

// sealedSecret готовит секрет к записи: пустой custom — наш случайный, иначе
// авторский после проверки. Отдаёт открытый вид (показать человеку) и
// шифротекст (положить в базу).
func (s *Service) sealedSecret(custom string) (string, []byte, error) {
	secret := strings.TrimSpace(custom)
	if secret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return "", nil, fmt.Errorf("webhook secret: %w", err)
		}
		secret = webhookSecretPrefix + base64.RawURLEncoding.EncodeToString(b)
	} else if err := checkWebhookSecret(secret); err != nil {
		return "", nil, err
	}
	sealed, err := sealWebhookSecret(s.key, secret)
	if err != nil {
		return "", nil, err
	}
	return secret, sealed, nil
}

// checkWebhookSecret — правила для секрета, заданного автором. Ввод валидируется
// на бэке независимо от фронта (инвариант 3).
func checkWebhookSecret(secret string) error {
	if n := utf8.RuneCountInString(secret); n < MinWebhookSecretLen || n > MaxWebhookSecretLen {
		return fmt.Errorf("%w: секрет должен быть длиной от %d до %d символов",
			domain.ErrValidation, MinWebhookSecretLen, MaxWebhookSecretLen)
	}
	// Управляющие символы в секрете — всегда промах при вставке (перенос строки
	// из письма, табуляция из таблицы), а не замысел: у получателя он не сойдётся.
	for _, r := range secret {
		if unicode.IsControl(r) {
			return fmt.Errorf("%w: в секрете есть переносы строк или табуляция — вставьте его одной строкой",
				domain.ErrValidation)
		}
	}
	return nil
}
