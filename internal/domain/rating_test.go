package domain

import (
	"encoding/json"
	"errors"
	"testing"
)

// Рейтинг — ряд звёзд 1..N. Проверки собраны в одном файле, потому что тип проходит
// через схему, приём ответа, сводку и условия тем же путём, что шкала (isScaleLike), и
// забытая ветка в любом из них трактовала бы рейтинг как свободный текст.

func TestValidateSchema_Rating(t *testing.T) {
	valid := map[string]string{
		"без числа звёзд — пять": `{"blocks":[{"id":"r","groupId":"g1","type":"rating","settings":{}}]}`,
		"три звезды":             `{"blocks":[{"id":"r","groupId":"g1","type":"rating","settings":{"ratingStars":3}}]}`,
		"десять звёзд":           `{"blocks":[{"id":"r","groupId":"g1","type":"rating","settings":{"ratingStars":10}}]}`,
	}
	for name, raw := range valid {
		t.Run("валидна: "+name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err != nil {
				t.Fatalf("ожидалась валидная схема: %v", err)
			}
		})
	}

	invalid := map[string]string{
		"две звезды":     `{"blocks":[{"id":"r","groupId":"g_r","type":"rating","settings":{"ratingStars":2}}]}`,
		"одиннадцать":    `{"blocks":[{"id":"r","groupId":"g_r","type":"rating","settings":{"ratingStars":11}}]}`,
		"отрицательное":  `{"blocks":[{"id":"r","groupId":"g_r","type":"rating","settings":{"ratingStars":-5}}]}`,
		"звёзды у шкалы": `{"blocks":[{"id":"s","groupId":"g_s","type":"scale","settings":{"ratingStars":5}}]}`,
	}
	for name, raw := range invalid {
		t.Run("невалидна: "+name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err == nil {
				t.Fatal("ожидалась ошибка, схема принята")
			} else if !errors.Is(err, ErrValidation) {
				t.Fatalf("ошибка не обёрнута ErrValidation: %v", err)
			}
		})
	}
}

// Ответ — строка с числом от 1 до числа звёзд. Нуля нет: это не NPS.
func TestValidateAnswers_Rating(t *testing.T) {
	five := FormSchema{Blocks: []Block{{ID: "r", Type: BlockRating, Required: true}}}
	ten := Block{ID: "r", Type: BlockRating}
	ten.Settings.RatingStars = 10

	for _, v := range []string{`"1"`, `"5"`} {
		if err := ValidateAnswers(five, raws(map[string]string{"r": v})); err != nil {
			t.Fatalf("%s — законная оценка из пяти: %v", v, err)
		}
	}
	if err := ValidateAnswers(FormSchema{Blocks: []Block{ten}}, raws(map[string]string{"r": `"10"`})); err != nil {
		t.Fatalf("десятая звезда у рейтинга из десяти: %v", err)
	}
	for name, v := range map[string]string{
		"ноль":              `"0"`,
		"выше числа звёзд":  `"6"`,
		"не целое":          `"4.5"`,
		"не число":          `"пять"`,
		"обязательный пуст": `""`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateAnswers(five, raws(map[string]string{"r": v})); err == nil {
				t.Fatalf("ожидалась ошибка для %s", v)
			}
		})
	}
}

// Сводка — распределение по всем звёздам, включая невыбранные.
func TestSummary_RatingBucketsCoverStars(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, Block{ID: "r", Type: BlockRating})})
	b.Add(1, sampleTime, ans(map[string]any{"r": "4"}))

	bs, counts := bucketsOf(t, b.Result(), "r")
	if bs.Kind != SummaryDistribution {
		t.Fatalf("рейтинг: вид сводки = %q, ожидалось распределение", bs.Kind)
	}
	if len(bs.Buckets) != DefaultRatingStars {
		t.Fatalf("делений = %d (%v), ожидалось %d", len(bs.Buckets), bs.Buckets, DefaultRatingStars)
	}
	if counts["4"] != 1 {
		t.Fatalf("распределение = %v, ожидалось 4:1", counts)
	}
	if c, ok := counts["1"]; !ok || c != 0 {
		t.Fatalf("звезда без ответов обязана быть в распределении: %v", counts)
	}
}

// Условия: рейтинг сравнивается числом — «≤ 2» применим, «содержит» нет.
func TestLogic_RatingIsNumeric(t *testing.T) {
	if !OpLte.appliesTo(BlockRating) {
		t.Error("«не больше» обязан применяться к рейтингу")
	}
	if OpContains.appliesTo(BlockRating) {
		t.Error("«содержит» к рейтингу не применяется")
	}
	if !sameAnswer(BlockRating, "5", "5.0") {
		t.Error("рейтинг сравнивается числом, а не строкой")
	}
	if !canReferenceAnswer(BlockRating, BlockScale) {
		t.Error("рейтинг сравним с ответом шкалы — оба числа")
	}
}
