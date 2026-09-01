package forms

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/token"
)

// Вёдра лимитера для тестов: лимит не ослабляется, а инжектируется другой
// реализацией (инвариант безопасности 6).
type allowLimiter struct{}

func (allowLimiter) Allow(string) bool { return true }

type denyLimiter struct{}

func (denyLimiter) Allow(string) bool { return false }

type fakePublicSvc struct {
	pf  PublicForm
	err error
	// badgeAllowed — разрешает ли тариф снимать бейдж (ключ form_branding).
	badgeAllowed bool
	badgeErr     error
	// partialAllowed — разрешает ли тариф сбор незавершённых (submissions_partial).
	partialAllowed bool
	partialErr     error
	// cardAllowed — разрешает ли тариф свою карточку ссылки (form_link_preview).
	cardAllowed bool
	cardErr     error
	// password — пароль формы в фейке (пусто = пароля нет).
	password string
}

func (f fakePublicSvc) PublicForm(_ context.Context, _ string) (PublicForm, error) {
	return f.pf, f.err
}

// testUnlockToken — «правильный» токен разблокировки в фейке. Настоящую подпись
// здесь проверять незачем (для неё есть unlock_test.go): транспорту важно ровно то,
// что он ПЕРЕДАЁТ заголовок и уважает отказ.
const testUnlockToken = "unlocked"

// VerifyUnlock повторяет ПРАВИЛО сервиса, а не результат: форма без пароля
// пропускается всегда, форма с паролем — только по годному токену.
func (f fakePublicSvc) VerifyUnlock(_ uuid.UUID, hasPassword bool, tok string) error {
	if !hasPassword || tok == testUnlockToken {
		return nil
	}
	return domain.ErrFormLocked
}

func (f fakePublicSvc) Unlock(_ context.Context, _, password string) (string, time.Time, error) {
	if f.password == "" || password != f.password {
		return "", time.Time{}, domain.ErrFormLocked
	}
	return testUnlockToken, time.Now().Add(time.Hour), nil
}

// ShowBadge в фейке повторяет ПРАВИЛО, а не результат: автор бейдж не снимал —
// бейдж стоит; снимал — решает подставленный тариф (badgeAllowed). Фейк,
// возвращающий константу, пропустил бы ровно тот дефект, ради которого поле и
// заведено, — потерянное намерение автора.
func (f fakePublicSvc) ShowBadge(_ context.Context, _ uuid.UUID, intent bool) (bool, error) {
	if intent {
		return true, nil
	}
	if f.badgeErr != nil {
		// «Спросить не удалось» — не «можно»: настоящий сервис в этом случае
		// оставляет бейдж, и фейк обязан повторять правило, а не упрощать его.
		return true, f.badgeErr
	}
	return !f.badgeAllowed, nil
}

// CollectPartial повторяет ПРАВИЛО сервиса: нет тумблера — сбора нет и тариф не
// спрашивается; есть тумблер — решает подставленный тариф. Фейк-константа
// пропустил бы ровно тот дефект, ради которого поле заведено, — сбор, продолжающийся
// после даунгрейда.
func (f fakePublicSvc) CollectPartial(_ context.Context, _ uuid.UUID, intent bool) (bool, error) {
	if !intent {
		return false, nil
	}
	return f.partialAllowed, f.partialErr
}

// LinkPreviewFor повторяет ПРАВИЛО сервиса, а не его результат: карточки нет —
// тариф не спрашивается вовсе; есть — решает подставленное право. Сбой опроса
// оставляет дефолты (карточка nil), как и настоящий сервис.
func (f fakePublicSvc) LinkPreviewFor(_ context.Context, _ uuid.UUID, p *domain.LinkPreview) (*domain.LinkPreview, error) {
	if p.Empty() {
		return nil, nil
	}
	if f.cardErr != nil {
		return nil, f.cardErr
	}
	if !f.cardAllowed {
		return nil, nil
	}
	return p, nil
}

var testSecret = []byte("dev-only-form-token-secret-not-a-real-key")

const (
	testBaseURL = "http://localhost:5174"
	testOGImage = "http://localhost:5174/og-preview.png"
)

// builtIndexFixture — реалистичный собранный index.html рендерера: хешированные
// имена ассетов (как их отдаёт vite-дефолт), favicon и — намеренно — лишний
// <link rel="preload">, которого Go «не знает». Тесты формы проверяют, что ВСЁ это
// доезжает в ответ дословно: доказательство, что добавление ассета в сборку не
// требует правок Go (DoD фазы 8, шаг 7). Точек вставки две: data-form-shell в теге
// <html> (оформление формы, фаза 22) и плейсхолдер og-меты в <head>.
const builtIndexFixture = `<!doctype html>
<html lang="ru" data-form-shell>
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!--og-meta-->
    <link rel="preload" href="/assets/font-a1b2c3.woff2" as="font" type="font/woff2" crossorigin>
    <script type="module" crossorigin src="/assets/index-ByZMBI6C.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-mIztBLt-.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

// writeFixtureIndex кладёт собранный index.html во временный файл и отдаёт путь.
func writeFixtureIndex(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "index.html")
	if err := os.WriteFile(path, []byte(builtIndexFixture), 0o600); err != nil {
		t.Fatalf("запись фикстуры index.html: %v", err)
	}
	return path
}

// newPublicMux — mux без страницы формы (indexHTMLPath пуст, как в dev): /r не
// регистрируется, обслуживается только JSON-ручка /public/v1.
func newPublicMux(t *testing.T, svc publicFormService) *http.ServeMux {
	t.Helper()
	return newPublicMuxWithUnlock(t, svc, allowLimiter{})
}

// newPublicMuxWithUnlock — тот же mux, но с заданным ведром попыток пароля: только
// с ним регистрируется ручка разблокировки. Пермиссивное ведро в тестах —
// инвариант 6 (лимитер подменяется, а не ослабляется).
func newPublicMuxWithUnlock(t *testing.T, svc publicFormService, unlock UnlockLimiter) *http.ServeMux {
	t.Helper()
	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, "", allowLimiter{}, false)
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.WithUnlockLimiter(unlock).Routes(mux)
	return mux
}

// newPublicHTMLMux — mux прод-контура: index.html задан, поэтому Go обслуживает /r.
func newPublicHTMLMux(t *testing.T, svc publicFormService) *http.ServeMux {
	t.Helper()
	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, writeFixtureIndex(t), allowLimiter{}, false)
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)
	return mux
}

func TestPublicGet_Published_ReturnsSchemaAndValidToken(t *testing.T) {
	vid := uuid.New()
	svc := fakePublicSvc{pf: PublicForm{
		Title:     "Опрос",
		Version:   2,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: vid,
		Status:    domain.FormStatusPublished,
	}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", rec.Code)
	}
	// В ETag не только id версии, но и состояние бейджа: тариф меняется без
	// переиздания, и без метки клиент вечно получал бы 304 с прежним телом.
	if got := rec.Header().Get("ETag"); got != `"`+vid.String()+`+b`+`"` {
		t.Fatalf("ETag = %q, ожидался id версии с меткой бейджа", got)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=60" {
		t.Fatalf("Cache-Control = %q", cc)
	}

	var body publicFormResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не парсится: %v", err)
	}
	if body.Title != "Опрос" || body.Version != 2 {
		t.Fatalf("неожиданное тело: %+v", body)
	}
	// Токена в кэшируемом теле быть не должно (ADR §10): его возраст мерил бы
	// возраст записи в кэше браузера, а не время заполнения формы.
	if bytes.Contains(rec.Body.Bytes(), []byte(`"token"`)) {
		t.Fatalf("в теле схемы есть token, а он выдаётся некэшируемой ручкой: %s", rec.Body.String())
	}
}

func TestPublicGet_Draft_Returns404(t *testing.T) {
	svc := fakePublicSvc{err: domain.ErrNotFound}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/draft", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404 (черновик/несуществующая не раскрывается)", rec.Code)
	}
}

// Закрытая форма (снята вручную) → 410 «приём закрыт» со своим текстом, без схемы и
// токена: форма была публичной, существование не скрываем (инвариант 5 — только
// черновик 404).
func TestPublicGet_ClosedManually_Returns410WithOwnMessage(t *testing.T) {
	msg := "Регистрация окончена, до встречи!"
	svc := fakePublicSvc{pf: PublicForm{
		Title:         "Опрос",
		Schema:        json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID:     uuid.New(),
		Status:        domain.FormStatusClosed,
		ClosedMessage: &msg,
	}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))

	if rec.Code != http.StatusGone {
		t.Fatalf("статус %d, ожидалось 410", rec.Code)
	}
	var body closedFormResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не парсится: %v", err)
	}
	if !body.Closed || body.Title != "Опрос" || body.ClosedMessage != msg {
		t.Fatalf("неожиданное тело закрытой формы: %+v", body)
	}
	if strings.Contains(rec.Body.String(), "schema") {
		t.Fatal("закрытая форма не должна отдавать схему")
	}
}

// Опубликованная форма, у которой достигнут лимит → тоже 410 (закрытость
// вычисляется), с дефолтным текстом (свой не задан).
func TestPublicGet_LimitReached_Returns410Default(t *testing.T) {
	limit := int32(100)
	svc := fakePublicSvc{pf: PublicForm{
		Title:           "Опрос",
		Schema:          json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID:       uuid.New(),
		Status:          domain.FormStatusPublished,
		ResponseLimit:   &limit,
		SubmissionCount: 100,
	}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))

	if rec.Code != http.StatusGone {
		t.Fatalf("статус %d, ожидалось 410", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, ожидался no-store (закрытость живая)", cc)
	}
	var body closedFormResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не парсится: %v", err)
	}
	if body.ClosedMessage != defaultClosedMessage {
		t.Fatalf("ожидался дефолтный текст, получено %q", body.ClosedMessage)
	}
}

func TestPublicGet_IfNoneMatch_Returns304(t *testing.T) {
	vid := uuid.New()
	svc := fakePublicSvc{pf: PublicForm{Title: "x", Version: 1, Schema: json.RawMessage(`{}`), VersionID: vid, Status: domain.FormStatusPublished}}
	req := httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil)
	req.Header.Set("If-None-Match", `"`+vid.String()+`+b`+`"`)

	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("статус %d, ожидалось 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 не должен нести тело, получено %d байт", rec.Body.Len())
	}
}

// --- Бейдж «Сделано в Trillix» (фаза 22, слайс 6; намерение переехало в живую
// колонку 2026-08-28, ADR §10) ---
//
// Решение принимается ПРИ ЗАХОДЕ НА ФОРМУ: намерение автора из колонки формы плюс
// разрешение тарифа. Отсюда три утверждения ниже.

func brandingForm(t *testing.T, removed bool, allowed bool) fakePublicSvc {
	t.Helper()
	schema := `{"schemaVersion":1,"blocks":[]}`
	if _, err := domain.ValidateSchema(json.RawMessage(schema)); err != nil {
		t.Fatalf("фикстура схемы не проходит валидатор: %v", err)
	}
	return fakePublicSvc{
		pf: PublicForm{
			Title: "Опрос", Version: 1, Schema: json.RawMessage(schema),
			VersionID: uuid.New(), Status: domain.FormStatusPublished,
			// Схема о бейдже не знает вовсе: намерение живёт колонкой, поэтому
			// снятый бейдж — это `Branding: false`, а не ключ в документе.
			Branding: !removed,
		},
		badgeAllowed: allowed,
	}
}

func getPublicJSON(t *testing.T, svc fakePublicSvc) (*httptest.ResponseRecorder, publicFormResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))
	var body publicFormResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("тело не парсится: %v", err)
		}
	}
	return rec, body
}

func TestPublicGet_Badge_ThreeCombinations(t *testing.T) {
	cases := []struct {
		name    string
		removed bool // автор просил снять
		allowed bool // тариф это разрешает
		want    bool // показывать бейдж
	}{
		{"намерения нет, тариф платный", false, true, true},
		{"намерение есть, тариф не даёт", true, false, true},
		{"намерение есть, тариф даёт", true, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, body := getPublicJSON(t, brandingForm(t, c.removed, c.allowed))
			if body.ShowBadge != c.want {
				t.Fatalf("showBadge = %v, ожидалось %v", body.ShowBadge, c.want)
			}
		})
	}
}

// Смена тарифа не меняет версию формы — значит обязана менять ETag, иначе
// подписавшийся автор получал бы 304 с прежним телом и бейджем у всех, кто форму
// уже открывал.
func TestPublicGet_BadgeState_ChangesETag(t *testing.T) {
	svc := brandingForm(t, true, false)
	withBadge, _ := getPublicJSON(t, svc)

	svc.badgeAllowed = true // тариф оплачен
	withoutBadge, _ := getPublicJSON(t, svc)

	if withBadge.Header().Get("ETag") == withoutBadge.Header().Get("ETag") {
		t.Fatalf("ETag не изменился со сменой тарифа: %q", withBadge.Header().Get("ETag"))
	}
}

// --- Шкала прогресса (миграция 0040) ---
//
// В отличие от бейджа, решения сервера здесь нет: тарифа у шкалы не бывает, и
// рендерер получает намерение автора как есть. Проверяются две вещи — что намерение
// доезжает и что его смена меняет ETag.

func TestPublicGet_Progress_CarriesIntent(t *testing.T) {
	for _, on := range []bool{true, false} {
		svc := brandingForm(t, false, true)
		svc.pf.Progress = on
		_, body := getPublicJSON(t, svc)
		if body.Progress != on {
			t.Fatalf("progress = %v, ожидалось %v", body.Progress, on)
		}
	}
}

// Тумблер шкалы не меняет опубликованную версию — значит обязан менять ETag. Иначе
// автор снял шкалу, а все, кто форму уже открывал, получают 304 с прежним телом и
// видят её до самой перепубликации.
func TestPublicGet_ProgressState_ChangesETag(t *testing.T) {
	svc := brandingForm(t, false, true)
	svc.pf.Progress = true
	withBar, _ := getPublicJSON(t, svc)

	svc.pf.Progress = false
	withoutBar, _ := getPublicJSON(t, svc)

	if withBar.Header().Get("ETag") == withoutBar.Header().Get("ETag") {
		t.Fatalf("ETag не изменился со снятием шкалы: %q", withBar.Header().Get("ETag"))
	}
}

// Бейдж стоит и на экране «приём закрыт»: иначе он снимается разглядыванием
// второго экрана.
func TestPublicGet_Closed_CarriesBadgeDecision(t *testing.T) {
	// ОБЕ ветки, а не одна: тест, проверяющий только «бейдж есть», прошёл бы и при
	// зашитой константе — то есть не заметил бы, что закрытая форма потеряла
	// намерение автора и показывает бейдж оплаченной подписке.
	cases := []struct {
		name    string
		removed bool
		allowed bool
		want    bool
	}{
		{"намерения нет", false, true, true},
		{"намерение есть и оплачено", true, true, false},
		{"намерение есть, тариф не даёт", true, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			svc := brandingForm(t, c.removed, c.allowed)
			svc.pf.Status = domain.FormStatusClosed

			rec := httptest.NewRecorder()
			newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))
			if rec.Code != http.StatusGone {
				t.Fatalf("статус %d, ожидалось 410", rec.Code)
			}
			var body closedFormResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("тело не парсится: %v", err)
			}
			if body.ShowBadge != c.want {
				t.Fatalf("showBadge = %v, ожидалось %v", body.ShowBadge, c.want)
			}
		})
	}
}

// Сбой опроса тарифа не имеет права уронить публичную форму: бейдж остаётся.
func TestPublicGet_PlanLookupFails_KeepsBadgeAndServes(t *testing.T) {
	svc := brandingForm(t, true, true)
	svc.badgeErr = errors.New("база недоступна")

	rec, body := getPublicJSON(t, svc)
	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200 — форма не должна падать из-за тарифов", rec.Code)
	}
	if !body.ShowBadge {
		t.Fatal("при сбое опроса тарифа бейдж обязан остаться")
	}
}

// В dev (indexHTMLPath пуст) Go не обслуживает /r — форму отдаёт vite-dev.
func TestPublicHTML_NoIndex_DoesNotServeR(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{Title: "x", Version: 1, Schema: json.RawMessage(`{}`), VersionID: uuid.New()}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/abc", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404 (в dev /r не регистрируется)", rec.Code)
	}
}

// Fail-fast: собранный index.html без плейсхолдера — ошибка старта, а не молчаливо
// битая форма на первом запросе краулера.
func TestNewPublicHandler_IndexMissingMarker_Errors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.html")
	if err := os.WriteFile(path, []byte(`<html><head></head><body><div id="root"></div></body></html>`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewPublicHandler(fakePublicSvc{}, testSecret, testBaseURL, testOGImage, path, allowLimiter{}, false); err == nil {
		t.Fatal("ожидалась ошибка старта для index.html без плейсхолдера <!--og-meta-->")
	}
}

// Fail-fast: нечитаемый/несуществующий путь — ошибка старта.
func TestNewPublicHandler_IndexUnreadable_Errors(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope", "index.html")
	if _, err := NewPublicHandler(fakePublicSvc{}, testSecret, testBaseURL, testOGImage, missing, allowLimiter{}, false); err == nil {
		t.Fatal("ожидалась ошибка старта для несуществующего index.html")
	}
}

// Ручка выдачи токена обязана быть НЕКЭШИРУЕМОЙ: токен, доехавший до респондента
// из кэша, стареет вместе с записью кэша, и окно [minFillTime, MaxAge] перестаёт
// измерять время заполнения формы (ADR §10). Тест держит именно заголовок — без
// него дефект возвращается молча и обнаруживается только на живой форме.
func TestFormToken_NoStore_AndSigned(t *testing.T) {
	rec := httptest.NewRecorder()
	newPublicMux(t, fakePublicSvc{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/form-token", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, ожидалось no-store", cc)
	}
	if etag := rec.Header().Get("ETag"); etag != "" {
		t.Fatalf("ETag = %q: ревалидация вернула бы прежний токен из кэша", etag)
	}

	var body formTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не парсится: %v", err)
	}
	if _, err := token.IssuedAt(testSecret, body.Token); err != nil {
		t.Fatalf("token невалиден: %v", err)
	}
}

// Два запроса дают РАЗНЫЕ токены со свежим временем: ручка выдаёт время сейчас, а
// не переиспользует однажды выпущенное.
func TestFormToken_IssuesFreshToken(t *testing.T) {
	mux := newPublicMux(t, fakePublicSvc{})

	issued := func() string {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/form-token", nil))
		var body formTokenResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("тело не парсится: %v", err)
		}
		at, err := token.IssuedAt(testSecret, body.Token)
		if err != nil {
			t.Fatalf("token невалиден: %v", err)
		}
		if age := time.Since(at); age > time.Minute {
			t.Fatalf("возраст токена %s — время выдачи не «сейчас»", age)
		}
		return body.Token
	}

	if first, second := issued(), issued(); first == second && !strings.Contains(first, ".") {
		t.Fatalf("токен не разбирается: %q", first)
	}
}

// Выдача токена — публичная ручка на чтение без авторизации, поэтому у неё своё
// ведро: без него токены заготавливаются пачкой (ADR §10).
func TestFormToken_RateLimited_Returns429(t *testing.T) {
	h, err := NewPublicHandler(fakePublicSvc{}, testSecret, testBaseURL, testOGImage, "", denyLimiter{}, false)
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/form-token", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус %d, ожидалось 429", rec.Code)
	}
}

// --- Пароль на форму (0047) -------------------------------------------------

// Форма под паролем не отдаёт схему: в теле 401 только название и бейдж.
func TestPublicGet_Locked_HidesSchema(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{
		Title:       "Опрос про доставку",
		Version:     1,
		VersionID:   uuid.New(),
		Schema:      json.RawMessage(`{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"label","text":[{"t":"Секретный вопрос"}]}]}`),
		Status:      "published",
		HasPassword: true,
	}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/s", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, want 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "Секретный вопрос") {
		t.Fatalf("схема утекла в тело отказа: %s", rec.Body.String())
	}
	var body struct {
		Locked bool   `json:"locked"`
		Title  string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("разбор тела: %v", err)
	}
	if !body.Locked {
		t.Fatal("тело не помечено как «под паролем»")
	}
	// Название формы на экране ввода ВИДНО (решение владельца, спека §2.3).
	if body.Title != "Опрос про доставку" {
		t.Fatalf("название = %q, want «Опрос про доставку»", body.Title)
	}
	// Тело формы под паролем не имеет права попасть в общий кэш.
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
}

// С годным токеном форма отдаётся как обычно — но по-прежнему без публичного кэша.
func TestPublicGet_Unlocked_ReturnsSchemaUncached(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{
		Title:       "Опрос",
		Version:     1,
		VersionID:   uuid.New(),
		Schema:      json.RawMessage(`{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"label","text":[{"t":"Вопрос"}]}]}`),
		Status:      "published",
		HasPassword: true,
	}}
	req := httptest.NewRequest(http.MethodGet, "/public/v1/forms/s", nil)
	req.Header.Set(UnlockHeader, testUnlockToken)
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Вопрос") {
		t.Fatalf("схема не отдана: %s", rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store: содержимое формы под паролем не кэшируется", cc)
	}
}

// Пароль — ПЕРВЫЙ барьер: текст экрана «приём закрыт» тоже написал автор, и до
// пароля его показывать не за что.
func TestPublicGet_LockedBeatsClosed(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{
		Title:         "Опрос",
		Version:       1,
		VersionID:     uuid.New(),
		Schema:        json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		Status:        "closed",
		ClosedMessage: ptr("Мы набрали участников, спасибо"),
		HasPassword:   true,
	}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/s", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, want 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "Мы набрали участников") {
		t.Fatalf("текст автора утёк до пароля: %s", rec.Body.String())
	}
}

func TestPublicUnlock(t *testing.T) {
	svc := fakePublicSvc{password: "правильный", pf: PublicForm{HasPassword: true}}
	mux := newPublicMux(t, svc)

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/public/v1/forms/s/unlock", strings.NewReader(body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	rec := post(`{"password":"неправильный"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("неверный пароль: статус = %d, want 401", rec.Code)
	}

	rec = post(`{"password":"правильный"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("верный пароль: статус = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Token     string `json:"token"`
		ExpiresIn int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("разбор тела: %v", err)
	}
	if body.Token == "" || body.ExpiresIn <= 0 {
		t.Fatalf("токен не выдан: %+v", body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
}

// ГЛАВНОЕ у лимита: ведро списывается ДО сравнения, поэтому исчерпавший его не
// проходит и с ВЕРНЫМ паролем. Иначе подбор стоил бы ровно столько же.
func TestPublicUnlock_LimitBeatsCorrectPassword(t *testing.T) {
	svc := fakePublicSvc{password: "правильный", pf: PublicForm{HasPassword: true}}
	mux := newPublicMuxWithUnlock(t, svc, denyLimiter{})

	req := httptest.NewRequest(http.MethodPost, "/public/v1/forms/s/unlock", strings.NewReader(`{"password":"правильный"}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, want 429", rec.Code)
	}
}
