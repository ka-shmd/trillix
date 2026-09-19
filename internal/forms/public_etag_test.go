package forms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

// ETag публичной формы следует за КАЖДЫМ полем тела, которое меняется без
// перепубликации. Иначе уже открывавший форму получает 304 с прежним телом и живёт
// со старым значением до новой версии.

func TestPublicGet_CollectPartialState_ChangesETag(t *testing.T) {
	svc := brandingForm(t, false, true)
	svc.partialAllowed = true
	etag := func() string {
		rec, _ := getPublicJSON(t, svc)
		return rec.Header().Get("ETag")
	}

	off := etag()
	svc.pf.CollectPartial = true // автор включил тумблер у опубликованной формы
	on := etag()
	svc.partialAllowed = false // даунгрейд: намерение то же, сбора больше нет
	downgraded := etag()

	if off == on {
		t.Fatalf("ETag не изменился с включением сбора незавершённых: %q", off)
	}
	if on == downgraded {
		t.Fatalf("ETag не изменился, когда тариф перестал разрешать сбор: %q", on)
	}
}

// fakeScheduleFacts отдаёт подставленные факты расписания; у формы без расписания
// фактов нет, как у настоящего booking.PublicService.
type fakeScheduleFacts struct{ facts *BookingFacts }

func (f *fakeScheduleFacts) FactsFor(_ context.Context, scheduleID *uuid.UUID) (*BookingFacts, error) {
	if scheduleID == nil {
		return nil, nil
	}
	return f.facts, nil
}

func TestPublicGet_BookingState_ChangesETag(t *testing.T) {
	svc := brandingForm(t, false, true)
	facts := &fakeScheduleFacts{facts: &BookingFacts{Timezone: "Europe/Moscow", MaxSeats: 1}}
	etag := func() string {
		t.Helper()
		h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, "", allowLimiter{}, false)
		if err != nil {
			t.Fatalf("NewPublicHandler: %v", err)
		}
		mux := http.NewServeMux()
		h.WithBooking(facts).Routes(mux)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("статус %d, ожидалось 200", rec.Code)
		}
		return rec.Header().Get("ETag")
	}

	seen := map[string]string{}
	step := func(name string) {
		t.Helper()
		e := etag()
		if prev, ok := seen[e]; ok {
			t.Fatalf("%s: ETag %q тот же, что при «%s»", name, e, prev)
		}
		seen[e] = name
	}

	step("расписания нет")
	id := uuid.New()
	svc.pf.ScheduleID = &id
	step("расписание привязано")
	facts.facts = &BookingFacts{Timezone: "Asia/Yekaterinburg", MaxSeats: 1}
	step("сменился пояс")
	facts.facts = &BookingFacts{Timezone: "Asia/Yekaterinburg", MaxSeats: 3}
	step("сменилось число мест")
	facts.facts = &BookingFacts{Timezone: "Asia/Yekaterinburg", MaxSeats: 3, ShowRemaining: true}
	step("включён показ остатка")
}
