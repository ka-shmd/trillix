package domain

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func crossVersions() []VersionedSchema {
	return []VersionedSchema{vs(1,
		planBlock(),
		scaleBlock("rate", "", 1, 3),
		Block{ID: "tags", Type: BlockMultiChoice, Settings: BlockSettings{Options: []Option{{ID: "t_a", Label: "А"}, {ID: "t_b", Label: "Б"}}}},
		Block{ID: "note", Type: BlockLongText},
	)}
}

func answersJSON(t *testing.T, s string) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCrosstab_Counts(t *testing.T) {
	b, err := NewCrosstabBuilder(crossVersions(), "plan", "rate")
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range []string{
		`{"plan":"o_pro","rate":"3"}`,
		`{"plan":"o_pro","rate":"3"}`,
		`{"plan":"o_free","rate":"1"}`,
		`{"plan":"o_free"}`, // на второй не ответил — в таблицу не входит
	} {
		b.Add(1, answersJSON(t, a))
	}
	got := b.Result()
	if got.Total != 3 {
		t.Errorf("в таблице %d ответов, ждали 3", got.Total)
	}
	if !reflect.DeepEqual(got.Cells, [][]int{{0, 0, 2}, {1, 0, 0}}) {
		t.Errorf("клетки: %v", got.Cells)
	}
	if got.Rows[0].Label != "Pro" || got.Rows[0].Count != 2 || got.Cols[2].Key != "3" || got.Cols[2].Count != 2 {
		t.Errorf("строки %+v, столбцы %+v", got.Rows, got.Cols)
	}
}

// Множественный выбор: ответ попадает в несколько клеток, итог строки — ответы.
func TestCrosstab_MultiChoice(t *testing.T) {
	b, err := NewCrosstabBuilder(crossVersions(), "tags", "plan")
	if err != nil {
		t.Fatal(err)
	}
	b.Add(1, answersJSON(t, `{"tags":["t_a","t_b"],"plan":"o_pro"}`))
	got := b.Result()
	if got.Total != 1 || got.Cells[0][0] != 1 || got.Cells[1][0] != 1 || got.Cols[0].Count != 1 {
		t.Errorf("множественный выбор: %+v", got)
	}
}

func TestCrosstab_RejectsNonClosed(t *testing.T) {
	for name, pair := range map[string][2]string{
		"текстовый":   {"plan", "note"},
		"сам с собой": {"plan", "plan"},
		"не вопрос":   {"plan", "ghost"},
	} {
		if _, err := NewCrosstabBuilder(crossVersions(), pair[0], pair[1]); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: %v, ждали ErrValidation", name, err)
		}
	}
}
