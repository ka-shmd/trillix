package domain

import (
	"encoding/json"
	"fmt"
)

// Таблица сопряжённости двух закрытых вопросов (спека design/analytics-v2.md §6.3):
// «тариф × оценка» — сколько ответов в каждой паре вариантов.
//
// Модель вопросов, подписи и деления — от сборщика сводки (SummaryBuilder): строки и
// столбцы таблицы обязаны совпадать с распределением этих вопросов над ней, и своя
// копия правил «что считать вариантом» разошлась бы с ним молча.

// Crosstab — итог. Rows и Cols — деления вопросов в порядке сводки; у каждого Count —
// сколько ответов с этим значением вошли в таблицу (ответили на оба вопроса). У
// множественного выбора ответ попадает в несколько клеток, поэтому сумма строки
// бывает больше её итога.
type Crosstab struct {
	Rows  []SummaryBucket
	Cols  []SummaryBucket
	Cells [][]int // [строка][столбец]
	// Total — ответов в таблице: оба вопроса показаны и отвечены.
	Total int
}

// CrosstabBuilder копит таблицу. Создаётся на запрос, Add — на каждый ответ.
type CrosstabBuilder struct {
	sb           *SummaryBuilder
	rowID, colID string
	rowAcc       *summaryAcc
	colAcc       *summaryAcc
	pairs        map[[2]string]int
	rowTotal     map[string]int
	colTotal     map[string]int
	total        int
}

// NewCrosstabBuilder — таблица вопросов rowID × colID. Оба обязаны быть закрытыми
// вопросами формы (выбор, шкала, звёзды) и разными — иначе ErrValidation.
func NewCrosstabBuilder(versions []VersionedSchema, rowID, colID string) (*CrosstabBuilder, error) {
	if rowID == colID {
		return nil, fmt.Errorf("%w: вопрос нельзя сравнить с самим собой", ErrValidation)
	}
	sb := NewSummaryBuilder(versions)
	rowAcc, colAcc := sb.acc[rowID], sb.acc[colID]
	for _, a := range []*summaryAcc{rowAcc, colAcc} {
		if a == nil || a.typ.summaryKind() != SummaryDistribution {
			return nil, fmt.Errorf("%w: сравнивать можно только вопросы с вариантами или шкалой", ErrValidation)
		}
	}
	return &CrosstabBuilder{
		sb: sb, rowID: rowID, colID: colID, rowAcc: rowAcc, colAcc: colAcc,
		pairs:    make(map[[2]string]int),
		rowTotal: make(map[string]int),
		colTotal: make(map[string]int),
	}, nil
}

// Add вливает ответ версии version. В таблицу он входит, только если оба вопроса в
// его версии были, показаны этому человеку (тот же вычислитель, что знаменатель
// сводки) и отвечены.
func (b *CrosstabBuilder) Add(version int, answers map[string]json.RawMessage) {
	types := b.sb.byVer[version]
	rowType, okR := types[b.rowID]
	colType, okC := types[b.colID]
	if !okR || !okC {
		return
	}
	plan := PlanForm(b.sb.blocksByVer[version], answers)
	if !plan.Visible[b.rowID] || !plan.Visible[b.colID] {
		return
	}
	rows := choiceValues(rowType, answers[b.rowID])
	cols := choiceValues(colType, answers[b.colID])
	if len(rows) == 0 || len(cols) == 0 {
		return
	}
	// Счётчики сводки нужны делениям шкалы вне диапазона свежей версии: без них
	// значение прежней шкалы потеряло бы строку.
	b.rowAcc.add(rowType, answers[b.rowID])
	b.colAcc.add(colType, answers[b.colID])

	b.total++
	for _, r := range rows {
		b.rowTotal[r]++
		for _, c := range cols {
			b.pairs[[2]string{r, c}]++
		}
	}
	for _, c := range cols {
		b.colTotal[c]++
	}
}

// Result собирает таблицу в порядке делений сводки.
func (b *CrosstabBuilder) Result() Crosstab {
	out := Crosstab{Rows: b.rowAcc.buckets(), Cols: b.colAcc.buckets(), Total: b.total}
	for i := range out.Rows {
		out.Rows[i].Count = b.rowTotal[out.Rows[i].Key]
	}
	for j := range out.Cols {
		out.Cols[j].Count = b.colTotal[out.Cols[j].Key]
	}
	out.Cells = make([][]int, len(out.Rows))
	for i, r := range out.Rows {
		out.Cells[i] = make([]int, len(out.Cols))
		for j, c := range out.Cols {
			out.Cells[i][j] = b.pairs[[2]string{r.Key, c.Key}]
		}
	}
	return out
}

// choiceValues — значения закрытого вопроса: id вариантов или деление шкалы. Пусто —
// не ответил.
func choiceValues(typ BlockType, raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	if typ.isMultiChoice() {
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			return nil
		}
		return ids
	}
	if v, ok := decodeString(raw); ok {
		return []string{v}
	}
	return nil
}
