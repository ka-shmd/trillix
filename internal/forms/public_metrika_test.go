package forms

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Счётчик Яндекс Метрики в публичной отдаче (фаза 29 DEV-PLAN, слайс C): номер
// уезжает, только если он подключён и тариф разрешает, а его смена меняет ETag.

// MetrikaFor в фейке повторяет ПРАВИЛО сервиса, а не результат: номера нет — тариф
// не спрашивается; есть — решает подставленное право; сбой опроса оставляет форму
// без счётчика.
func (f fakePublicSvc) MetrikaFor(_ context.Context, _ uuid.UUID, counter *string) (*string, error) {
	if counter == nil {
		return nil, nil
	}
	if f.metrikaErr != nil {
		return nil, f.metrikaErr
	}
	if !f.metrikaAllowed {
		return nil, nil
	}
	return counter, nil
}

func metrikaForm(t *testing.T, counter *string, allowed bool) fakePublicSvc {
	t.Helper()
	svc := brandingForm(t, false, true)
	svc.pf.MetrikaCounter = counter
	svc.metrikaAllowed = allowed
	return svc
}

func orNil(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestPublicGet_Metrika_ServerDecision(t *testing.T) {
	number := "12345678"
	cases := []struct {
		name    string
		counter *string // номер в строке формы: подключён и включён
		allowed bool    // тариф разрешает счётчик
		want    *string
	}{
		{"счётчик не подключён", nil, true, nil},
		{"подключён, тариф не даёт", &number, false, nil},
		{"подключён, тариф даёт", &number, true, &number},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, body := getPublicJSON(t, metrikaForm(t, c.counter, c.allowed))
			if orNil(body.Metrika) != orNil(c.want) {
				t.Fatalf("metrika = %s, ожидалось %s", orNil(body.Metrika), orNil(c.want))
			}
		})
	}
}

// Подключение, снятие и смена номера не меняют версию формы — значит обязаны менять
// ETag, иначе все, кто форму уже открывал, получали бы 304 со старым счётчиком.
func TestPublicGet_MetrikaState_ChangesETag(t *testing.T) {
	first, second := "12345678", "87654321"
	svc := metrikaForm(t, nil, true)
	etag := func() string {
		rec, _ := getPublicJSON(t, svc)
		return rec.Header().Get("ETag")
	}

	without := etag()
	svc.pf.MetrikaCounter = &first
	withFirst := etag()
	svc.pf.MetrikaCounter = &second
	withSecond := etag()

	if without == withFirst {
		t.Fatalf("ETag не изменился с подключением счётчика: %q", without)
	}
	if withFirst == withSecond {
		t.Fatalf("ETag не изменился со сменой номера: %q", withFirst)
	}
}

// Сбой опроса тарифа не роняет форму и не ставит на страницу счётчик без права.
func TestPublicGet_MetrikaPlanLookupFails_ServesWithoutCounter(t *testing.T) {
	number := "12345678"
	svc := metrikaForm(t, &number, true)
	svc.metrikaErr = errors.New("база недоступна")

	rec, body := getPublicJSON(t, svc)
	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200 — форма не должна падать из-за тарифов", rec.Code)
	}
	if body.Metrika != nil {
		t.Fatalf("при сбое опроса тарифа счётчик уехал на страницу: %s", *body.Metrika)
	}
}

// Закрытую форму и форму под паролем заполнить нельзя — счётчику там отмечать нечего.
func TestPublicGet_ClosedAndLocked_HaveNoMetrika(t *testing.T) {
	number := "12345678"
	closed := metrikaForm(t, &number, true)
	closed.pf.Status = domain.FormStatusClosed
	locked := metrikaForm(t, &number, true)
	locked.pf.PasswordSealed = []byte{1, 2}

	for name, svc := range map[string]fakePublicSvc{"закрыта": closed, "под паролем": locked} {
		rec := httptest.NewRecorder()
		newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))
		if rec.Code == http.StatusOK {
			t.Fatalf("%s: статус 200, ожидался отказ", name)
		}
		if body := rec.Body.String(); strings.Contains(body, "metrika") || strings.Contains(body, number) {
			t.Fatalf("%s: в теле отказа счётчик: %s", name, body)
		}
	}
}
