// Команда printer — сервис печати: получает адрес страницы, возвращает PDF.
//
// Отдельный процесс и отдельный образ, потому что печатает его headless-Chromium, а
// тот не кладётся в distroless-образ api (ADR §10). Своего состояния у сервиса нет:
// ни базы, ни файлов, ни кеша — он обёртка над одним запуском браузера.
//
// БРАУЗЕР ЗАПУСКАЕТСЯ НА ДОКУМЕНТ И УМИРАЕТ ВМЕСТЕ С НИМ. Ни пула, ни CDP, ни
// долгоживущей вкладки: печатей единицы, а резидентный браузер стоил бы сотни
// мегабайт памяти круглосуточно на машине, где рядом работает Postgres.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ka-shmd/trillix/internal/config"
)

const (
	// printTimeout — потолок на один запуск браузера. Страница своя и лёгкая;
	// всё, что дольше, — это зависшая загрузка, а не медленная печать.
	printTimeout = 30 * time.Second
	// virtualTimeBudget — сколько браузеру ждать «успокоения» страницы (загрузка
	// шрифтов и картинок) до печати. Миллисекунды; свой аргумент chromium.
	virtualTimeBudget = 10000
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg := config.LoadPrinter()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("POST /print", func(w http.ResponseWriter, r *http.Request) {
		handlePrint(w, r, cfg.ChromiumBin, cfg.APIOrigin, log)
	})

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// Печать длится дольше обычной ручки — запись ответа ждёт браузера.
		WriteTimeout: printTimeout + 10*time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Info("printer listening", slog.String("addr", cfg.HTTPAddr),
		slog.String("chromium", cfg.ChromiumBin), slog.String("api", cfg.APIOrigin))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("printer stopped", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

type printRequest struct {
	// Path — путь на api, а не полный адрес: origin принтер знает сам (config).
	// Печатать что-то за пределами нашего api он не умеет — и это не ограничение
	// возможностей, а отсутствие SSRF-примитива в продукте.
	Path string `json:"path"`
}

func handlePrint(w http.ResponseWriter, r *http.Request, chromium, origin string, log *slog.Logger) {
	var req printRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Путь остаётся путём: ведущий слеш обязателен, «//» и «:» отсекаются — иначе
	// «//зло.example/x» стал бы адресом чужого хоста, а «file:» — файловой системой
	// контейнера.
	if !strings.HasPrefix(req.Path, "/") || strings.HasPrefix(req.Path, "//") || strings.Contains(req.Path, ":") {
		http.Error(w, "path must be an absolute path on the api origin", http.StatusBadRequest)
		return
	}

	pageURL := origin + req.Path
	// СТРАНИЦА ПРОВЕРЯЕТСЯ ДО ЗАПУСКА БРАУЗЕРА. Без этого принтер печатает что дали:
	// на 404 (протухший токен, ненастроенная печать) chromium честно отрисовал бы
	// страницу ошибки, и автор получил бы валидный PDF с JSON-отказом внутри —
	// худший вид отказа, потому что он выглядит успехом.
	if err := checkPage(r.Context(), pageURL); err != nil {
		log.Error("page not printable", slog.String("error", err.Error()))
		http.Error(w, "page not printable", http.StatusBadGateway)
		return
	}

	started := time.Now()
	pdf, err := printPage(r.Context(), chromium, pageURL)
	if err != nil {
		log.Error("print failed", slog.String("error", err.Error()),
			slog.Duration("elapsed", time.Since(started)))
		http.Error(w, "print failed", http.StatusBadGateway)
		return
	}

	log.Info("printed", slog.Int("bytes", len(pdf)), slog.Duration("elapsed", time.Since(started)))
	w.Header().Set("Content-Type", "application/pdf")
	if _, err := w.Write(pdf); err != nil {
		log.Warn("print response write failed", slog.String("error", err.Error()))
	}
}

// checkPageTimeout — потолок на предварительную проверку страницы. Она у нас же и
// рядом: секунды хватает с запасом, а зависший api не должен доедать время печати.
const checkPageTimeout = 5 * time.Second

// checkPage убеждается, что по адресу лежит наша страница, а не отказ. Проверяются
// две вещи: статус (200) и тип (HTML) — сразу за ними идёт браузер, которому всё
// равно, что рисовать.
//
// Цена — второй запрос той же страницы. Она невелика (документ отдаёт наш api из
// файла и памяти) и оплачена тем, что отказ остаётся отказом, а не превращается в
// PDF с текстом ошибки.
func checkPage(ctx context.Context, pageURL string) error {
	ctx, cancel := context.WithTimeout(ctx, checkPageTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return fmt.Errorf("build check request: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("check page: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("page status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		return fmt.Errorf("page content-type %q, want text/html", ct)
	}
	return nil
}

// printPage запускает браузер, ждёт документ и читает его с диска.
//
// Через файл, а не через stdout: `--print-to-pdf` умеет только файл. Каталог
// временный и свой на каждую печать — вместе с ним уезжает и профиль браузера,
// поэтому две одновременные печати не спорят за общий user-data-dir.
func printPage(ctx context.Context, chromium, pageURL string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "print-*")
	if err != nil {
		return nil, fmt.Errorf("temp dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	out := filepath.Join(dir, "out.pdf")
	ctx, cancel := context.WithTimeout(ctx, printTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, chromium,
		"--headless=new",
		// Песочница браузера в контейнере требует привилегий, которых у сервиса нет
		// и быть не должно. Изоляцию здесь даёт сам контейнер: он без сети наружу
		// не ходит никуда, кроме api, и своего состояния не имеет.
		"--no-sandbox",
		"--disable-gpu",
		// /dev/shm в контейнере мал по умолчанию; без этого браузер падает на
		// странице с картинками.
		"--disable-dev-shm-usage",
		"--disable-extensions",
		"--no-first-run",
		"--hide-scrollbars",
		"--user-data-dir="+dir,
		"--no-pdf-header-footer",
		fmt.Sprintf("--virtual-time-budget=%d", virtualTimeBudget),
		"--print-to-pdf="+out,
		pageURL,
	)
	// WaitDelay — страховка от зависшего браузера. CommandContext по отмене убивает
	// САМ процесс, но CombinedOutput ждёт закрытия pipe'а, а его держат живые внуки:
	// chromium плодит дочерние процессы, и осиротевший рендерер удерживал бы горутину
	// печати после того, как всё уже отменено. С задержкой pipe закрывается
	// принудительно, и запрос отдаёт ошибку, а не висит.
	cmd.WaitDelay = 2 * time.Second
	if combined, err := cmd.CombinedOutput(); err != nil {
		// Вывод браузера — единственное, что объясняет отказ; он идёт в лог сервиса,
		// а не наружу.
		return nil, fmt.Errorf("chromium: %w: %s", err, combined)
	}

	pdf, err := os.ReadFile(out)
	if err != nil {
		return nil, fmt.Errorf("read printed file: %w", err)
	}
	return pdf, nil
}
