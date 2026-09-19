package domain

import (
	"encoding/json"
	"testing"
	"time"
)

func answer(id, v string) map[string]json.RawMessage {
	raw, _ := json.Marshal(v)
	return map[string]json.RawMessage{id: raw}
}

// NPS: доля 9–10 минус доля 0–6. 10, 9 — промоутеры, 7 — нейтрал, 3 — критик:
// (2 − 1) / 4 = 25.
func TestSummary_ScaleAvgAndNPS(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, scaleBlock("nps", "", 0, 10))})
	for _, v := range []string{"10", "9", "7", "3"} {
		b.Add(1, time.Now(), answer("nps", v))
	}
	s := b.Result().Blocks[0].Scale
	if s == nil || s.Avg != 7.25 || s.NPS == nil || *s.NPS != 25 {
		t.Fatalf("шкала 0–10: %+v", s)
	}
}

// У шкалы 1–5 «промоутеров» нет: NPS не считается, средняя — да.
func TestSummary_ScaleWithoutNPS(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, scaleBlock("sat", "", 1, 5))})
	b.Add(1, time.Now(), answer("sat", "4"))
	b.Add(1, time.Now(), answer("sat", "5"))
	s := b.Result().Blocks[0].Scale
	if s == nil || s.Avg != 4.5 || s.NPS != nil {
		t.Fatalf("шкала 1–5: %+v", s)
	}
}

func TestSummary_RatingAvg(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, Block{ID: "stars", Type: BlockRating})})
	b.Add(1, time.Now(), answer("stars", "3"))
	b.Add(1, time.Now(), answer("stars", "4"))
	s := b.Result().Blocks[0].Scale
	if s == nil || s.Avg != 3.5 || s.NPS != nil {
		t.Fatalf("звёзды: %+v", s)
	}
}

// Никто не ответил — статистики нет вовсе, а не «средняя 0».
func TestSummary_ScaleNoAnswers(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, scaleBlock("nps", "", 0, 10))})
	b.Add(1, time.Now(), map[string]json.RawMessage{})
	if s := b.Result().Blocks[0].Scale; s != nil {
		t.Fatalf("без ответов: %+v", s)
	}
}

// Ряд — все корзины окна подряд; день без ответов — N = 0, а не пропавшая точка и не
// «средняя 0».
func TestSummary_ScaleTrend(t *testing.T) {
	day1 := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	day3 := day1.AddDate(0, 0, 2)
	b := NewSummaryBuilder([]VersionedSchema{vs(1, scaleBlock("nps", "", 0, 10))})
	b.Trend(StepDay, time.Time{}, time.Time{})
	b.Add(1, day1, answer("nps", "8"))
	b.Add(1, day1, answer("nps", "10"))
	b.Add(1, day3, answer("nps", "4"))

	tr := b.Result().Blocks[0].Scale.Trend
	if len(tr) != 3 {
		t.Fatalf("корзин %d, ждали 3: %+v", len(tr), tr)
	}
	if tr[0].N != 2 || tr[0].Avg != 9 || tr[1].N != 0 || tr[2].N != 1 || tr[2].Avg != 4 {
		t.Errorf("ряд: %+v", tr)
	}
	if !tr[1].At.Equal(time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("пустая корзина не на своём месте: %v", tr[1].At)
	}
}

// Без заказанного ряда корзин нет: окну «все ответы» и прочим потребителям сборщика
// ряд не нужен.
func TestSummary_ScaleTrendOnlyWhenAsked(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, scaleBlock("nps", "", 0, 10))})
	b.Add(1, time.Now(), answer("nps", "8"))
	if tr := b.Result().Blocks[0].Scale.Trend; tr != nil {
		t.Fatalf("ряд без заказа: %+v", tr)
	}
}

// Диапазон сменили после сбора ответов: средняя и NPS считаются только по ответам
// действующей шкалы, распределение — по всем.
//
// Без этого отбора все ответы старой пятибалльной уезжали в критики NPS (n <= 6), и
// форма со сплошными «отлично» показывала NPS 0 при фактическом +100.
func TestSummary_ScaleRangeChanged(t *testing.T) {
	versions := []VersionedSchema{
		vs(1, scaleBlock("q", "", 1, 5)),
		vs(2, scaleBlock("q", "", 0, 10)),
	}
	b := NewSummaryBuilder(versions)
	for _, v := range []string{"4", "5"} { // старая шкала: «хорошо» и «отлично»
		b.Add(1, time.Now(), answer("q", v))
	}
	for _, v := range []string{"9", "10"} { // действующая шкала
		b.Add(2, time.Now(), answer("q", v))
	}

	blk := b.Result().Blocks[0]
	s := blk.Scale
	if s == nil {
		t.Fatal("шкалы нет")
	}
	if s.Avg != 9.5 {
		t.Errorf("средняя = %v, ждали 9.5 (только ответы шкалы 0–10)", s.Avg)
	}
	if s.NPS == nil || *s.NPS != 100 {
		t.Errorf("NPS = %v, ждали 100: ответы шкалы 1–5 в формулу не входят", s.NPS)
	}
	// Распределение считает все четыре: деление стоит на своём месте по числу.
	total := 0
	for _, bk := range blk.Buckets {
		total += bk.Count
	}
	if total != 4 {
		t.Errorf("в распределении %d ответов, ждали все 4", total)
	}
	if blk.Answered != 4 {
		t.Errorf("answered = %d, ждали 4: отбор диапазона знаменатель вопроса не трогает", blk.Answered)
	}
}

// Действующей шкалы не видел ни один респондент (диапазон сменили после сбора):
// средней и NPS нет вовсе, а не «средняя 0».
func TestSummary_ScaleRangeChanged_NoCurrentAnswers(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{
		vs(1, scaleBlock("q", "", 1, 5)),
		vs(2, scaleBlock("q", "", 0, 10)),
	})
	b.Add(1, time.Now(), answer("q", "5"))

	blk := b.Result().Blocks[0]
	if blk.Scale != nil {
		t.Errorf("шкала = %+v, ждали nil", blk.Scale)
	}
	if blk.Answered != 1 {
		t.Errorf("answered = %d, ждали 1", blk.Answered)
	}
}
