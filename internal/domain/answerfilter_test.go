package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func planBlock() Block {
	return Block{ID: "plan", Type: BlockSingleChoice, Settings: BlockSettings{Options: []Option{{ID: "o_pro", Label: "Pro"}, {ID: "o_free", Label: "Free"}}}}
}

func rawAnswers(pairs ...string) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for i := 0; i+1 < len(pairs); i += 2 {
		b, _ := json.Marshal(pairs[i+1])
		out[pairs[i]] = b
	}
	return out
}

func TestParseAnswerFilter(t *testing.T) {
	f := AnswerFilter{{BlockID: "plan", Op: OpIs, Value: "o_pro"}, {BlockID: "age", Op: OpAnswered}}
	got, err := ParseAnswerFilter(EncodeAnswerFilter(f))
	if err != nil || len(got) != 2 || got[0].Value != "o_pro" {
		t.Fatalf("разбор: %+v, %v", got, err)
	}
	if got, err := ParseAnswerFilter(""); err != nil || got != nil {
		t.Errorf("пустой фильтр: %+v, %v", got, err)
	}

	bad := map[string]string{
		"не base64":       "@@@",
		"группа":          EncodeAnswerFilter(AnswerFilter{{All: []Condition{{BlockID: "a", Op: OpAnswered}}}}),
		"ссылка":          EncodeAnswerFilter(AnswerFilter{{BlockID: "a", Op: OpIs, ValueRef: "b"}}),
		"без значения":    EncodeAnswerFilter(AnswerFilter{{BlockID: "a", Op: OpIs}}),
		"оператор":        EncodeAnswerFilter(AnswerFilter{{BlockID: "a", Op: "like"}}),
		"лишнее поле":     "eyJ4IjoxfQ",
		"много условий":   EncodeAnswerFilter(make(AnswerFilter, MaxFilterConditions+1)),
		"слишком длинный": strings.Repeat("A", maxFilterParamLen+1),
	}
	for name, raw := range bad {
		if _, err := ParseAnswerFilter(raw); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: ошибка %v, ждали ErrValidation", name, err)
		}
	}
}

func TestAnswerFilter_Check(t *testing.T) {
	qs := QuestionOrder([]VersionedSchema{vs(1, planBlock(), Block{ID: "note", Type: BlockLongText})})
	if err := (AnswerFilter{{BlockID: "plan", Op: OpIs, Value: "o_pro"}}).Check(qs); err != nil {
		t.Errorf("годный фильтр: %v", err)
	}
	for name, f := range map[string]AnswerFilter{
		"не вопрос":          {{BlockID: "ghost", Op: OpAnswered}},
		"оператор не к типу": {{BlockID: "plan", Op: OpContains, Value: "x"}},
	} {
		if err := f.Check(qs); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: %v, ждали ErrValidation", name, err)
		}
	}
}

func TestAnswerFilter_Match(t *testing.T) {
	blocks := []Block{planBlock(), {ID: "note", Type: BlockLongText}, {ID: "age", Type: BlockNumber}}
	f := AnswerFilter{{BlockID: "plan", Op: OpIs, Value: "o_pro"}, {BlockID: "age", Op: OpGte, Value: "18"}}

	if !f.Match(blocks, rawAnswers("plan", "o_pro", "age", "30")) {
		t.Error("оба условия выполнены, ответ не прошёл")
	}
	if f.Match(blocks, rawAnswers("plan", "o_pro", "age", "12")) {
		t.Error("«И»: второе условие не выполнено, ответ прошёл")
	}
	if f.Match(blocks, rawAnswers("plan", "o_free", "age", "30")) {
		t.Error("первое условие не выполнено, ответ прошёл")
	}
	// Текст — без регистра, как в логике формы.
	if !(AnswerFilter{{BlockID: "note", Op: OpContains, Value: "ДОРОГО"}}).Match(blocks, rawAnswers("note", "Слишком дорого")) {
		t.Error("contains без регистра не сработал")
	}
	// Вопроса нет в версии ответа — условие не выполняется, даже «пусто».
	if (AnswerFilter{{BlockID: "ghost", Op: OpEmpty}}).Match(blocks, rawAnswers()) {
		t.Error("условие о вопросе, которого в версии не было, выполнилось")
	}
	if !(AnswerFilter(nil)).Match(blocks, rawAnswers()) {
		t.Error("пустой фильтр отсёк ответ")
	}
}
