package submissions

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// ПЕЧАТНАЯ СТРАНИЦА ОТВЕТА — внутренний транспорт (ADR §10). Её открывает не
// человек, а headless-браузер контейнера `printer`, и весь этот файл существует
// ради одного: отдать браузеру самодостаточный документ, не пуская его ни в API
// кабинета, ни к чужой сессии.
//
// Пути лежат под /internal/, куда Caddy запросы снаружи не проксирует вовсе (на
// кабинете — только /api/*, на рендерере — /r/* и /public/*). Это первая линия;
// вторая — подписанный токен печати (printtoken.go), без которого документ не
// отдаётся, даже если до пути кто-то дотянулся.
//
// Данные впечатываются в документ, а не запрашиваются страницей: запрос требовал бы
// от браузера принтера авторизации, то есть или cookie (её у него нет и не должно
// быть), или второго токена. Приём тот же, каким Go отдаёт HTML публичной формы
// (internal/forms/public_page.go), и плейсхолдер тот же по духу.

// printDataMarker — плейсхолдер в собранном print.html (web/renderer/print.html),
// на место которого Go подставляет данные ответа. Ровно одно вхождение: два
// означали бы, что документ вставлен не туда, — и это ловится на старте.
const printDataMarker = "<!--print-data-->"

// printService — часть сервиса, нужная печатной странице. Прав не спрашивает: их
// проверил тот, кто выдал токен (см. Service.AuthorizePrint).
type printService interface {
	PrintDocFor(ctx context.Context, formID, submissionID uuid.UUID) (PrintDoc, error)
}

// PrintPageHandler отдаёт документ печатной страницы и её ассеты.
type PrintPageHandler struct {
	svc      printService
	secret   []byte
	htmlPath string
	// assetsDir — каталог собранных ассетов печати рядом с print.html. Раздаётся
	// файловым сервером: имена в нём хешированные (их проставил vite), и Go, как и
	// у формы, списка ассетов не ведёт.
	assetsDir string
	now       func() time.Time
}

// NewPrintPageHandler готовит транспорт печати. Документ читается прямо сейчас —
// чтобы отсутствие файла или плейсхолдера уронило СТАРТ, а не первую печать (тот же
// fail-fast, что у index.html рендерера).
//
// formTokenSecret — секрет контура, из которого выводится секрет печати
// (printtoken.go); своей переменной окружения у печати нет.
func NewPrintPageHandler(svc printService, formTokenSecret []byte, htmlPath string) (*PrintPageHandler, error) {
	if _, _, err := readPrintHTML(htmlPath); err != nil {
		return nil, err
	}
	return &PrintPageHandler{
		svc:       svc,
		secret:    derivePrintSecret(formTokenSecret),
		htmlPath:  htmlPath,
		assetsDir: filepath.Join(filepath.Dir(htmlPath), "assets"),
		now:       time.Now,
	}, nil
}

func (h *PrintPageHandler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /internal/print/doc/{token}", http.HandlerFunc(h.document))
	mux.Handle("GET /internal/print/assets/", http.StripPrefix("/internal/print/assets/",
		http.FileServer(http.Dir(h.assetsDir))))
}

// readPrintHTML читает собранный print.html и разрезает его по плейсхолдеру.
//
// Читается на КАЖДУЮ печать, а не один раз при старте, и это осознанно: выкатка
// может обновить только статику (тег образа тот же — контейнер api не пересоздаётся),
// и разобранный при старте документ ссылался бы на несуществующие ассеты навсегда.
// У формы та же беда решена сверкой mtime и кешем — здесь кеш не нужен вовсе:
// печатей единицы, а файл — несколько килобайт.
func readPrintHTML(path string) (head, tail string, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("read print page %s: %w", path, err)
	}
	html := string(raw)
	if n := strings.Count(html, printDataMarker); n != 1 {
		return "", "", fmt.Errorf("print page %s: %q must occur exactly once, found %d", path, printDataMarker, n)
	}
	i := strings.Index(html, printDataMarker)
	return html[:i], html[i+len(printDataMarker):], nil
}

// printPayload — то, что печатная страница получает впечатанным в документ. Зеркало
// Zod-схемы web/renderer/src/print/data.ts: разъедутся — страница честно скажет
// «печатать нечего» вместо листа с ответом.
type printPayload struct {
	SubmissionID string               `json:"submissionId"`
	FormVersion  int32                `json:"formVersion"`
	SubmittedAt  string               `json:"submittedAt"`
	Schema       json.RawMessage      `json:"schema"`
	Answers      json.RawMessage      `json:"answers"`
	Files        map[string]printFile `json:"files"`
	// MediaBase — префикс, из которого страница строит адреса картинок. Для браузера
	// принтера наш api — весь мир: раздачи Caddy он не видит, поэтому обложка,
	// логотип и картинки блоков едут через /internal/print/media (internal/media).
	MediaBase string `json:"mediaBase"`
	// Timezone — пояс расписания формы (пусто = записи нет). Время записи на бумаге
	// пишется в нём: у контейнера печати своего пояса нет, и без этой строки лист
	// вставал бы в UTC.
	Timezone string `json:"timezone"`
}

type printFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// printCSP — политика печатной страницы, и она ОБЯЗАТЕЛЬНА, а не гигиена.
//
// На странице лежит CSS АВТОРА ФОРМЫ (design.css, платная возможность), и вся
// безопасность этой возможности держится на политике: `customCss.ts` так и написано —
// «сторож текста, а не стена, стена это CSP». Публичной форме политику ставит Caddy,
// но печатную страницу Caddy не видит вовсе (`/internal/*` он не проксирует), и без
// этого заголовка чужой CSS получал бы право звать внешние адреса из НАШЕГО браузера
// печати: `background: url(http://…)` в контейнере, который сидит во внутренней сети
// рядом с api и базой. Это не утечка ответа — это чужой запрос нашими руками.
//
// Состав уже, чем у формы: печатной странице не нужны ни blob:, ни фреймы, ни
// соединения (данные приезжают впечатанными). `unsafe-inline` для стилей оставлен —
// на нём и стоит вся возможность своего оформления; `data:` у картинок и шрифтов —
// как у публичной формы, чтобы вид не разошёлся.
const printCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; " +
	"base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'"

// printMediaBase — префикс адресов картинок на печатной странице. Один на все
// контуры: путь внутренний и от домена не зависит.
const printMediaBase = "/internal/print"

// document отдаёт печатную страницу одного ответа по токену. Любая беда с токеном —
// 404, а не 401/403: наружу этот путь не существует, и рассказывать пришедшему, чем
// именно плох его токен, незачем.
func (h *PrintPageHandler) document(w http.ResponseWriter, r *http.Request) {
	formID, submissionID, err := parsePrintToken(h.secret, r.PathValue("token"), h.now())
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}

	doc, err := h.svc.PrintDocFor(r.Context(), formID, submissionID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	payload := printPayload{
		SubmissionID: doc.ID.String(),
		FormVersion:  doc.FormVersion,
		SubmittedAt:  doc.CreatedAt.UTC().Format(time.RFC3339),
		Schema:       doc.Schema,
		Answers:      doc.Answers,
		Files:        make(map[string]printFile, len(doc.Files)),
		MediaBase:    printMediaBase,
		Timezone:     doc.Timezone,
	}
	for id, f := range doc.Files {
		payload.Files[id] = printFile{Name: f.Name, Size: f.Size}
	}
	// Ответы респондента едут внутрь <script> — json.Marshal экранирует «<» и «>»
	// даже внутри RawMessage, поэтому «</script>» в чужом ответе документ не рвёт.
	// МИНА: перейдёшь на Encoder — не забудь, что SetEscapeHTML(false) это ломает.
	data, err := json.Marshal(payload)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("marshal print payload of submission %s: %w", submissionID, err))
		return
	}

	head, tail, err := readPrintHTML(h.htmlPath)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Документ содержит чужой ответ: ни кешу, ни поисковику его видеть не положено.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex")
	w.Header().Set("Content-Security-Policy", printCSP)
	if _, err := fmt.Fprint(w, head,
		`<script type="application/json" id="print-data">`, string(data), `</script>`,
		tail); err != nil {
		httpserver.LoggerFrom(r.Context()).Warn("print page write failed", "error", err.Error())
	}
}
