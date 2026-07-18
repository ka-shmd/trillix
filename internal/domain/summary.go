package domain

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// Сводка ответов (фаза 8.5 шаг 3): распределение по вариантам, статистика чисел и
// доля заполнивших — по каждому вопросу формы. Чистая свёртка: ни HTTP, ни SQL.
// Сервис читает ответы пачками и скармливает их сюда по одному (Add), в памяти
// копятся только счётчики — O(вариантов), не O(ответов).
//
// Считает Go, а не SQL (решение владельца, DEV-PLAN фаза 8.5 шаг 3): семантика
// ответа («yes» — отмеченное согласие, массив — множественный выбор, «4» — деление
// шкалы) живёт в типах блока, то есть здесь. Тот же диспатч по типам, что в CSV;
// выражать его ещё и на SQL значило бы завести третью копию правил после Go и Zod —
// а забытая ветка в такой копии не падает, а молча врёт (см. «три грабли» в
// web/shared/fields/README.md).
//
// Модель колонок — правило CSV (csv.go): объединение блоков по ВСЕМ версиям формы,
// порядок и подпись — из свежайшей версии, где блок есть. Сводка и выгрузка обязаны
// показывать одно и то же множество вопросов, иначе владелец видит в них разные формы.

// SummaryKind — как показывается сводка вопроса. Зеркалит дискриминант Zod-схемы
// на фронте (web/app/src/entities/summary.ts).
type SummaryKind string

const (
	// SummaryDistribution — распределение по вариантам: choice-типы, шкала, согласие.
	SummaryDistribution SummaryKind = "distribution"
	// SummaryNumber — среднее/мин/макс: тип number.
	SummaryNumber SummaryKind = "number"
	// SummaryFill — только доля заполнивших: свободный текст, телефон, email, дата.
	// Осмысленно агрегировать их нечем — распределение по уникальным ответам это тот
	// же список ответов, он уже есть в таблице.
	SummaryFill SummaryKind = "fill"
)

// summaryKind — вид сводки по типу блока. Ветвление предикатами, а не сравнением с
// конкретным типом: новый choice-тип иначе молча уехал бы в SummaryFill и показывал
// бы «заполнили N» вместо распределения.
func (t BlockType) summaryKind() SummaryKind {
	switch {
	case t.isChoice(), t == BlockScale, t == BlockConsent:
		return SummaryDistribution
	case t == BlockNumber:
		return SummaryNumber
	default:
		return SummaryFill
	}
}

// SummaryBucket — одно деление распределения: вариант выбора, отметка шкалы или
// «Да»/«Нет» согласия. Key — внутреннее значение (id опции, число шкалы), Label —
// то, что видит владелец.
type SummaryBucket struct {
	Key   string
	Label string
	Count int
}

// NumberStats — статистика числового вопроса по ответившим (не по всем визитам).
type NumberStats struct {
	Avg float64
	Min float64
	Max float64
}

// BlockSummary — сводка одного вопроса.
//
// Asked — сколько ответов пришло по версиям, где этот вопрос БЫЛ (знаменатель), а не
// сколько ответов у формы всего: вопрос, добавленный в v2, не должен выглядеть
// «пропущенным» у всех, кто отвечал по v1. Answered — сколько на него ответили
// непусто.
type BlockSummary struct {
	BlockID  string
	Label    string
	Type     BlockType
	Kind     SummaryKind
	Asked    int
	Answered int
	Buckets  []SummaryBucket // Kind == SummaryDistribution
	Number   *NumberStats    // Kind == SummaryNumber, nil если никто не ответил
}

// Summary — результат свёртки: всего ответов у формы и сводка по каждому вопросу.
type Summary struct {
	Total  int
	Blocks []BlockSummary
}

// SummaryBuilder копит счётчики. Создаётся один раз на запрос, затем Add вызывается
// на каждый ответ, Result собирает итог.
type SummaryBuilder struct {
	order []string                     // block_id в порядке вопросов (свежая версия слева)
	acc   map[string]*summaryAcc       // block_id → счётчики
	byVer map[int]map[string]BlockType // версия → block_id → тип В ТОЙ версии
	total int
}

// summaryAcc — счётчики одного вопроса.
type summaryAcc struct {
	label    string
	typ      BlockType // тип из свежайшей версии — им определяется вид сводки
	optOrder []string  // id опций: порядок и состав — объединение по версиям
	optLabel map[string]string
	counts   map[string]int // id опции / число шкалы / ConsentYes → сколько раз
	asked    int
	answered int
	// Диапазон шкалы из свежайшей версии: деления с нулём ответов обязаны быть в
	// распределении, иначе бары врут о форме шкалы.
	scaleMin, scaleMax int
	// Числа: сумма и границы по ответившим.
	sum, min, max float64
	numCount      int
}

// NewSummaryBuilder разбирает версии в модель вопросов. versions ожидаются по
// возрастанию номера (как их отдаёт forms.Versions) — как у NewCSVBuilder.
func NewSummaryBuilder(versions []VersionedSchema) *SummaryBuilder {
	b := &SummaryBuilder{
		acc:   make(map[string]*summaryAcc),
		byVer: make(map[int]map[string]BlockType, len(versions)),
	}

	for _, v := range versions {
		types := make(map[string]BlockType, len(v.Schema.Blocks))
		for _, blk := range v.Schema.Blocks {
			types[blk.ID] = blk.Type
		}
		b.byVer[v.Version] = types
	}

	// Вопросы и их порядок — общая модель по всем версиям (questions.go): сводка,
	// выгрузка и воронка обязаны показывать один и тот же список вопросов.
	for _, q := range QuestionOrder(versions) {
		a := &summaryAcc{
			label:    q.Label,
			typ:      q.Block.Type,
			optLabel: make(map[string]string),
			counts:   make(map[string]int),
		}
		if q.Block.Type == BlockScale {
			// Диапазон — из свежайшей версии с этим блоком (q.Block): деления шкалы
			// показываем те, что видит сегодняшний респондент.
			a.scaleMin, a.scaleMax = scaleRange(q.Block)
		}
		b.acc[q.ID] = a
		b.order = append(b.order, q.ID)
	}

	// Опции собираются ОТДЕЛЬНЫМ обходом всех версий, а не берутся из q.Block:
	// вариант, удалённый в свежей версии, всё ещё имеет выбравших его по старой, и
	// без него их ответы стали бы безымянными. Порядок тот же — от свежей к старой,
	// первое появление опции фиксирует позицию и подпись.
	for i := len(versions) - 1; i >= 0; i-- {
		for _, blk := range versions[i].Schema.Blocks {
			a, ok := b.acc[blk.ID]
			if !ok {
				continue // неотвечаемый блок: в модель вопросов не входит
			}
			for _, o := range blk.Settings.Options {
				if _, seen := a.optLabel[o.ID]; seen {
					continue
				}
				a.optLabel[o.ID] = o.Label
				a.optOrder = append(a.optOrder, o.ID)
			}
		}
	}
	return b
}

// Add вливает в сводку один ответ: version — версия, по которой он отправлен,
// answers — разобранная карта block_id → сырое значение.
func (b *SummaryBuilder) Add(version int, answers map[string]json.RawMessage) {
	b.total++

	// Идём по блокам ВЕРСИИ ОТВЕТА, а не по присланным ответам: вопрос, который
	// человек видел и пропустил, обязан попасть в знаменатель (asked), хотя ключа в
	// answers для него нет. Ответ на блок, которого в этой версии не было, здесь же
	// отсекается — в сводку он не попадёт (в CSV-выгрузке он тоже пуст).
	for id, typ := range b.byVer[version] {
		a, ok := b.acc[id]
		if !ok {
			continue // неотвечаемый блок: acc для него не заводился
		}
		a.asked++
		raw, answered := answers[id]
		if !answered {
			continue
		}
		// Тип берётся из версии ответа, а не из свежей: смена типа блока владельцем
		// не должна заставлять разбирать старый ответ по новым правилам.
		a.add(typ, raw)
	}
}

// add разбирает одно значение по типу блока в его версии. Ошибка разбора не валит
// сводку — значение просто не учитывается (данные проходили ValidateAnswers при
// приёме, но версия и тип могли разойтись). Пустая строка/пустой массив — «не
// ответил» (конвенция проекта), в answered не идут.
func (a *summaryAcc) add(typ BlockType, raw json.RawMessage) {
	switch {
	case typ.isSingleChoice():
		id, ok := decodeString(raw)
		if !ok {
			return
		}
		a.answered++
		a.counts[id]++
	case typ == BlockMultiChoice:
		var ids []string
		if json.Unmarshal(raw, &ids) != nil || len(ids) == 0 {
			return
		}
		a.answered++
		for _, id := range ids {
			a.counts[id]++
		}
	case typ == BlockConsent:
		// Отмеченное согласие — единственное непустое значение (ValidateAnswers
		// другого не пропустит). «Нет» не копится счётчиком, а считается в Result
		// как asked - answered: неотмеченный чекбокс приходит пустым либо не
		// приходит вовсе, и обе формы обязаны попасть в «Нет» одинаково.
		if _, ok := decodeString(raw); !ok {
			return
		}
		a.answered++
		a.counts[ConsentYes]++
	case typ == BlockScale:
		v, ok := decodeString(raw)
		if !ok {
			return
		}
		a.answered++
		a.counts[v]++
	case typ == BlockNumber:
		v, ok := decodeString(raw)
		if !ok {
			return
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			// Защитно: validNumber при приёме такого не пропускает.
			return
		}
		a.answered++
		if a.numCount == 0 || f < a.min {
			a.min = f
		}
		if a.numCount == 0 || f > a.max {
			a.max = f
		}
		a.sum += f
		a.numCount++
	default:
		// Свободный текст, телефон, email, дата: считаем только факт заполнения.
		// Пробельный ответ — не ответ (в отличие от ValidateAnswers, которому
		// достаточно непустой строки): здесь это число на экране владельца.
		v, ok := decodeString(raw)
		if !ok || strings.TrimSpace(v) == "" {
			return
		}
		a.answered++
	}
}

// decodeString — значение-строка; false, если это не строка или она пуста («не
// ответил»).
func decodeString(raw json.RawMessage) (string, bool) {
	var v string
	if json.Unmarshal(raw, &v) != nil || v == "" {
		return "", false
	}
	return v, true
}

// Result собирает итог: вопросы в порядке колонок, у каждого — свой вид сводки.
func (b *SummaryBuilder) Result() Summary {
	out := Summary{Total: b.total, Blocks: make([]BlockSummary, 0, len(b.order))}
	for _, id := range b.order {
		a := b.acc[id]
		s := BlockSummary{
			BlockID:  id,
			Label:    a.label,
			Type:     a.typ,
			Kind:     a.typ.summaryKind(),
			Asked:    a.asked,
			Answered: a.answered,
		}
		switch s.Kind {
		case SummaryDistribution:
			s.Buckets = a.buckets()
		case SummaryNumber:
			if a.numCount > 0 {
				s.Number = &NumberStats{Avg: a.sum / float64(a.numCount), Min: a.min, Max: a.max}
			}
		case SummaryFill:
			// Доля считается на фронте из Answered/Asked — числа уже есть.
		}
		out.Blocks = append(out.Blocks, s)
	}
	return out
}

// buckets — деления распределения по типу вопроса.
func (a *summaryAcc) buckets() []SummaryBucket {
	switch a.typ {
	case BlockConsent:
		// Согласие — не «сколько отметили из ответивших», а «сколько согласились из
		// тех, кого спросили»: неотмеченный чекбокс это осмысленное «нет», а не
		// пропуск (см. add).
		return []SummaryBucket{
			{Key: ConsentYes, Label: "Да", Count: a.answered},
			{Key: "", Label: "Нет", Count: a.asked - a.answered},
		}
	case BlockScale:
		return a.scaleBuckets()
	default:
		// Остальные распределения — choice-типы: варианты из объединения версий.
		return a.optionBuckets()
	}
}

// optionBuckets — варианты choice-вопроса в порядке объединения версий. Выбранный
// id, которого нет ни в одной версии, показывается как есть и в конце: факт ответа
// не теряется (правило optionLabel в csv.go).
func (a *summaryAcc) optionBuckets() []SummaryBucket {
	out := make([]SummaryBucket, 0, len(a.optOrder))
	for _, id := range a.optOrder {
		out = append(out, SummaryBucket{Key: id, Label: optionLabel(a.optLabel, id), Count: a.counts[id]})
	}
	unknown := make([]string, 0)
	for id := range a.counts {
		if _, known := a.optLabel[id]; !known {
			unknown = append(unknown, id)
		}
	}
	sort.Strings(unknown) // порядок карты случаен — сводка обязана быть стабильной
	for _, id := range unknown {
		out = append(out, SummaryBucket{Key: id, Label: id, Count: a.counts[id]})
	}
	return out
}

// scaleBuckets — все деления диапазона свежей версии, включая те, что никто не
// выбрал (иначе бары врут о форме шкалы). Значение из версии с другим диапазоном не
// выбрасывается, а встаёт на своё место по числу.
func (a *summaryAcc) scaleBuckets() []SummaryBucket {
	seen := make(map[int]struct{})
	marks := make([]int, 0, a.scaleMax-a.scaleMin+1)
	for n := a.scaleMin; n <= a.scaleMax; n++ {
		marks = append(marks, n)
		seen[n] = struct{}{}
	}
	for k := range a.counts {
		n, err := strconv.Atoi(k)
		if err != nil {
			continue
		}
		if _, ok := seen[n]; !ok {
			marks = append(marks, n)
			seen[n] = struct{}{}
		}
	}
	sort.Ints(marks)

	out := make([]SummaryBucket, 0, len(marks))
	for _, n := range marks {
		key := strconv.Itoa(n)
		out = append(out, SummaryBucket{Key: key, Label: key, Count: a.counts[key]})
	}
	return out
}
