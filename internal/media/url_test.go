package media

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/safehttp"
)

// fakeFetcher — скачивание по ссылке без сети: отказ проверки, исход запроса и тело
// задаются тестом, вызовы считаются.
type fakeFetcher struct {
	validateErr error
	status      int
	body        []byte
	getErr      error
	validated   int
	got         int
	gotLimit    int64
}

func (f *fakeFetcher) Validate(_ context.Context, raw string) (*url.URL, error) {
	f.validated++
	if f.validateErr != nil {
		return nil, f.validateErr
	}
	return url.Parse(raw)
}

func (f *fakeFetcher) Get(_ context.Context, _ string, limit int64) (safehttp.Response, []byte, error) {
	f.got++
	f.gotLimit = limit
	return safehttp.Response{StatusCode: f.status}, f.body, f.getErr
}

const coverURL = "https://images.example/covers/secret-token/pic.png"

func TestUploadFromURL_КладётКартинкуКакФайл(t *testing.T) {
	ws := uuid.New()
	store := &fakeBlob{}
	fetch := &fakeFetcher{status: http.StatusOK, body: makePNG(t, 4, 4)}
	svc := NewService(fakeForms{form: forms.Form{WorkspaceID: ws}}, store, "app-media").WithFetcher(fetch)

	key, err := svc.UploadFromURL(context.Background(), uuid.New(), uuid.New(), coverURL, PurposeCover)
	if err != nil {
		t.Fatalf("UploadFromURL: %v", err)
	}
	if !strings.HasPrefix(key, ws.String()+"/") || !store.called {
		t.Fatalf("ключ %q, blob вызван=%v: ожидалась картинка в бакете под воркспейсом", key, store.called)
	}
	if fetch.gotLimit != MaxImageBytes {
		t.Fatalf("потолок тела %d, ожидался MaxImageBytes", fetch.gotLimit)
	}
}

func TestUploadFromURL_ПравоДоСети(t *testing.T) {
	store := &fakeBlob{}
	fetch := &fakeFetcher{status: http.StatusOK, body: makePNG(t, 2, 2)}
	svc := NewService(fakeForms{err: domain.ErrNotFound}, store, "app-media").WithFetcher(fetch)

	_, err := svc.UploadFromURL(context.Background(), uuid.New(), uuid.New(), coverURL, PurposeCover)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, ожидалось ErrNotFound", err)
	}
	if fetch.validated+fetch.got != 0 || store.called {
		t.Fatal("без права на форму сервер не должен ходить по чужому адресу")
	}
}

func TestUploadFromURL_Отказы(t *testing.T) {
	cases := []struct {
		name  string
		fetch fakeFetcher
		want  string // кусок человеческой причины
	}{
		{
			"внутренняя сеть при проверке",
			fakeFetcher{validateErr: fmt.Errorf("%w: 10.0.0.5", safehttp.ErrForbiddenAddress)},
			"внутреннюю сеть",
		},
		{"не https", fakeFetcher{validateErr: safehttp.ErrScheme}, "https://"},
		{
			"тело больше потолка",
			fakeFetcher{getErr: fmt.Errorf("%w: images.example", safehttp.ErrBodyTooLarge)},
			"больше 5 МБ",
		},
		{"редирект", fakeFetcher{status: http.StatusFound}, "прямую ссылку"},
		{"нет картинки", fakeFetcher{status: http.StatusNotFound}, "кодом 404"},
		{"не картинка", fakeFetcher{status: http.StatusOK, body: []byte("<html>")}, "PNG/JPEG"},
		{"обрыв соединения", fakeFetcher{getErr: errors.New("get images.example: EOF")}, "не удалось скачать"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeBlob{}
			fetch := tc.fetch
			svc := NewService(fakeForms{form: forms.Form{WorkspaceID: uuid.New()}}, store, "app-media").WithFetcher(&fetch)

			_, err := svc.UploadFromURL(context.Background(), uuid.New(), uuid.New(), coverURL, PurposeCover)
			if !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, ожидался ErrValidation с «%s»", err, tc.want)
			}
			// Путь ссылки — возможный секрет: в тексте отказа его нет.
			if strings.Contains(err.Error(), "secret-token") {
				t.Fatalf("текст отказа несёт путь ссылки: %v", err)
			}
			if store.called {
				t.Fatal("отказ не должен класть объект в бакет")
			}
		})
	}
}

func TestUploadFromURL_БезКлиентаНедоступно(t *testing.T) {
	svc := NewService(fakeForms{form: forms.Form{WorkspaceID: uuid.New()}}, &fakeBlob{}, "app-media")
	_, err := svc.UploadFromURL(context.Background(), uuid.New(), uuid.New(), coverURL, PurposeCover)
	if !errors.Is(err, domain.ErrUnavailable) {
		t.Fatalf("err = %v, ожидалось ErrUnavailable", err)
	}
}
