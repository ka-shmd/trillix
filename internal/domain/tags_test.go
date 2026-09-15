package domain

import "testing"

// Теги (multi_select) отличаются от multi_choice только контролом: ответ — массив id, и
// каждая ветка, знающая множественный выбор, обязана знать и их. Забытая ветка не падает,
// а читает массив как строку — и ответ молча пропадает из сводки или выгрузки.

func tagsBlock(required bool) Block {
	b := Block{ID: "t", Type: BlockMultiSelect, Required: required}
	b.Settings.Options = []Option{{ID: "msk", Label: "Москва"}, {ID: "kzn", Label: "Казань"}}
	return b
}

func TestValidateAnswers_MultiSelect(t *testing.T) {
	s := FormSchema{Blocks: []Block{tagsBlock(true)}}
	if err := ValidateAnswers(s, raws(map[string]string{"t": `["msk","kzn"]`})); err != nil {
		t.Fatalf("два известных тега: %v", err)
	}
	for name, v := range map[string]string{
		"строка вместо массива": `"msk"`,
		"чужой id":          `["spb"]`,
		"обязательный пуст": `[]`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateAnswers(s, raws(map[string]string{"t": v})); err == nil {
				t.Fatalf("ожидалась ошибка для %s", v)
			}
		})
	}
}

func TestSummary_MultiSelectCountsEachTag(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, tagsBlock(false))})
	b.Add(1, sampleTime, ans(map[string]any{"t": []string{"msk", "kzn"}}))
	b.Add(1, sampleTime, ans(map[string]any{"t": []string{"kzn"}}))

	bs, counts := bucketsOf(t, b.Result(), "t")
	if bs.Kind != SummaryDistribution {
		t.Fatalf("теги: вид сводки = %q, ожидалось распределение", bs.Kind)
	}
	if counts["Москва"] != 1 || counts["Казань"] != 2 {
		t.Fatalf("распределение = %v, ожидалось Москва:1 Казань:2", counts)
	}
	if bs.Answered != 2 {
		t.Fatalf("ответивших = %d, ожидалось 2 (человек, а не тегов)", bs.Answered)
	}
}

func TestLogic_MultiSelectIsMulti(t *testing.T) {
	if !OpIncludes.appliesTo(BlockMultiSelect) {
		t.Error("«содержит вариант» обязан применяться к тегам")
	}
	if OpIs.appliesTo(BlockMultiSelect) {
		t.Error("«равно» у массива неопределимо")
	}
}
