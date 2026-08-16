package domain

import (
	"regexp"
	"slices"
	"strconv"
	"testing"
)

// Паритет условной логики (фаза 21): состав операторов и числа лимитов совпадают с
// фронтом. Тест ЧИТАЕТ TypeScript по тем же доводам, что blockkinds_parity_test.go:
// копия таблицы, живущая рядом с проверяемым кодом, разъезжается вместе с ним.
//
// Почему именно эти две вещи машинно. Оператор, добавленный в одну сторону и забытый в
// другой, не падает — он МОЛЧА не срабатывает: билдер даёт автору выбрать «больше
// пяти», рендерер честно прячет вопрос, а сервер такое правило считает инертным и
// принимает ответы, которых автор не ждал. Лимит, разошедшийся числом, даёт то же
// молчание с другой стороны: фронт отвергает правило, которое сервер бы принял.
//
// Семантика (что оператор ЗНАЧИТ) машинной сверке недоступна — её держат таблицы
// кейсов одинакового состава: logic_test.go здесь и web/app/src/entities/logic.test.ts
// там. Расхождение состава видно диффом, потому что названия кейсов совпадают.

var (
	reLogicOperators = regexp.MustCompile(`(?s)LOGIC_OPERATORS = \[(.*?)\] as const`)
	reLogicActions   = regexp.MustCompile(`(?s)LOGIC_ACTIONS = \[(.*?)\] as const`)
	reLogicLimit     = regexp.MustCompile(`export const (MAX_LOGIC_\w+|MAX_JUMP_RULES) = (\d+)`)
)

func TestLogicOperatorsParity(t *testing.T) {
	m := reLogicOperators.FindStringSubmatch(readTSFile(t, "conditions.ts"))
	if m == nil {
		t.Fatal("не удалось прочитать LOGIC_OPERATORS из blocks/conditions.ts")
	}

	var ts []LogicOp
	seen := map[LogicOp]bool{}
	for _, q := range reQuoted.FindAllStringSubmatch(m[1], -1) {
		op := LogicOp(q[1])
		if seen[op] {
			t.Fatalf("оператор %s разобран дважды — разбор LOGIC_OPERATORS сломался", op)
		}
		seen[op] = true
		ts = append(ts, op)
	}
	if len(ts) == 0 {
		t.Fatal("LOGIC_OPERATORS пуст — разбор blocks/logic.ts сломался")
	}

	// Порядок тоже сверяется: он контрактный (по нему читаются обе таблицы кейсов), и
	// расхождение порядка — верный признак того, что оператор добавили не туда.
	if !slices.Equal(ts, logicOps) {
		t.Fatalf("состав операторов разошёлся:\n  TS: %v\n  Go: %v", ts, logicOps)
	}
}

// Действия сверяются тем же способом и по той же причине, что операторы: действие,
// добавленное на одной стороне, не падает — оно молча не срабатывает. Билдер даст автору
// выбрать «скрыть кнопку», а сервер такого действия не знает и отправку пропустит.
func TestLogicActionsParity(t *testing.T) {
	m := reLogicActions.FindStringSubmatch(readTSFile(t, "logic.ts"))
	if m == nil {
		t.Fatal("не удалось прочитать LOGIC_ACTIONS из blocks/logic.ts")
	}

	var ts []LogicActionKind
	seen := map[LogicActionKind]bool{}
	for _, q := range reQuoted.FindAllStringSubmatch(m[1], -1) {
		a := LogicActionKind(q[1])
		if seen[a] {
			t.Fatalf("действие %s разобрано дважды — разбор LOGIC_ACTIONS сломался", a)
		}
		seen[a] = true
		ts = append(ts, a)
	}
	if len(ts) == 0 {
		t.Fatal("LOGIC_ACTIONS пуст — разбор blocks/logic.ts сломался")
	}
	if !slices.Equal(ts, logicActions) {
		t.Fatalf("состав действий разошёлся:\n  TS: %v\n  Go: %v", ts, logicActions)
	}
}

func TestLogicLimitsParity(t *testing.T) {
	want := map[string]int{
		"MAX_LOGIC_DEPTH":     MaxLogicDepth,
		"MAX_LOGIC_NODES":     MaxLogicNodes,
		"MAX_LOGIC_VALUE_LEN": MaxLogicValueLen,
		"MAX_JUMP_RULES":      MaxJumpRules,
		"MAX_LOGIC_ACTIONS":   MaxLogicActions,
	}

	found := map[string]int{}
	for _, m := range reLogicLimit.FindAllStringSubmatch(readTSFile(t, "limits.ts"), -1) {
		n, err := strconv.Atoi(m[2])
		if err != nil {
			t.Fatalf("лимит %s не число: %v", m[1], err)
		}
		found[m[1]] = n
	}

	for name, goValue := range want {
		tsValue, ok := found[name]
		if !ok {
			t.Fatalf("лимит %s не найден в blocks/limits.ts", name)
		}
		if tsValue != goValue {
			t.Fatalf("лимит %s разошёлся: TS %d, Go %d", name, tsValue, goValue)
		}
	}
	if len(found) != len(want) {
		t.Fatalf("в limits.ts лимитов логики %d, в Go %d — один из них новый и не сверяется", len(found), len(want))
	}
}
