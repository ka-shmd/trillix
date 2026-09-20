package domain

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
)

// Фильтр ответов аналитики (спека design/analytics-v2.md §6.2, ADR §10): условия,
// объединённые «И». Условие — ЛИСТ условия логики формы (Condition: blockId, op,
// value) и вычисляется тем же вычислителем, что видимость вопросов, — третьего языка
// условий аналитика не заводит.

// AnswerFilter — список условий; пустой — фильтра нет.
type AnswerFilter []Condition

// MaxFilterConditions — потолок условий фильтра; maxFilterParamLen — потолок длины
// параметра в адресе до разбора.
const (
	MaxFilterConditions = 10
	maxFilterParamLen   = 8 << 10
)

// ParseAnswerFilter разбирает параметр `where`: base64url (без выравнивания) от
// JSON-массива условий. Пустая строка — фильтра нет. Проверяется форма каждого листа
// (те же правила, что у условия логики); принадлежность вопросам формы проверяет
// Check — для неё нужна модель вопросов.
func ParseAnswerFilter(raw string) (AnswerFilter, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > maxFilterParamLen {
		return nil, fmt.Errorf("%w: фильтр слишком длинный", ErrValidation)
	}
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: неверный фильтр", ErrValidation)
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var f AnswerFilter
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("%w: неверный фильтр", ErrValidation)
	}
	if len(f) > MaxFilterConditions {
		return nil, fmt.Errorf("%w: в фильтре больше %d условий", ErrValidation, MaxFilterConditions)
	}
	for i, c := range f {
		// Только лист: группы «и/или» фильтр не принимает (решение владельца, Р2), а
		// ссылка на ответ другого вопроса в правой части владельцу не предлагается.
		if len(c.All) > 0 || len(c.Any) > 0 || c.ValueRef != "" {
			return nil, fmt.Errorf("%w: условие %d фильтра — не сравнение ответа со значением", ErrValidation, i+1)
		}
		nodes := 0
		if err := validateCondNode(c, fmt.Sprintf("условие %d фильтра", i+1), 1, &nodes); err != nil {
			return nil, fmt.Errorf("%w: %s", ErrValidation, err)
		}
		if c.Op.needsValue() && c.Value == "" {
			return nil, fmt.Errorf("%w: у условия %d фильтра нет значения", ErrValidation, i+1)
		}
	}
	return f, nil
}

// Check — условия ссылаются на вопросы формы, и оператор осмыслен у типа вопроса
// (свежайшей версии, где он есть). Иначе условие было бы инертным, а инертный фильтр
// молча показал бы пустую сводку.
func (f AnswerFilter) Check(questions []Question) error {
	byID := make(map[string]Question, len(questions))
	for _, q := range questions {
		byID[q.ID] = q
	}
	for i, c := range f {
		q, ok := byID[c.BlockID]
		if !ok {
			return fmt.Errorf("%w: условие %d фильтра ссылается не на вопрос формы", ErrValidation, i+1)
		}
		if !c.Op.appliesTo(q.Block.Type) {
			return fmt.Errorf("%w: условие %d фильтра не подходит к вопросу «%s»", ErrValidation, i+1, q.Label)
		}
	}
	return nil
}

// Match — проходит ли ответ фильтр. blocks — блоки ВЕРСИИ ответа: вопроса, которого в
// ней не было, человеку не задавали, и условие о нём не выполняется — «пусто» здесь
// значило бы «не отвечал», чего не было.
func (f AnswerFilter) Match(blocks []Block, answers map[string]json.RawMessage) bool {
	if len(f) == 0 {
		return true
	}
	ev := &evaluator{
		pos:     make(map[string]int, len(f)),
		byID:    make(map[string]Block, len(f)),
		decided: make(map[string]answerValue, len(f)),
	}
	for _, c := range f {
		for i := range blocks {
			if blocks[i].ID == c.BlockID {
				ev.byID[c.BlockID] = blocks[i]
				ev.pos[c.BlockID] = i
				ev.decided[c.BlockID] = decodeAnswer(blocks[i], answers[c.BlockID], nil)
				break
			}
		}
	}
	for _, c := range f {
		// Носитель «после всех блоков»: у фильтра нет места в документе, все ответы
		// уже решены.
		res, ok := ev.leaf(c, math.MaxInt)
		if !ok || !res {
			return false
		}
	}
	return true
}

// EncodeAnswerFilter — обратное к ParseAnswerFilter; нужен тестам и зеркалу фронта.
func EncodeAnswerFilter(f AnswerFilter) string {
	body, _ := json.Marshal(f)
	return base64.RawURLEncoding.EncodeToString(body)
}

// AnswerScope — выборка ответов аналитики: фильтр по ответам и сегмент по визиту
// (спека design/analytics-v2.md §6.2, §6.4). Нулевая — все ответы окна.
type AnswerScope struct {
	Filter   AnswerFilter
	Segments Segments
}

func (s AnswerScope) IsZero() bool { return len(s.Filter) == 0 && s.Segments.IsZero() }

// Withheld — выборку нельзя раскрыть: визитный сегмент, и в ней меньше SegmentK
// ответов. Фильтр только по ответам порогом не закрывается — эти ответы владелец и так
// видит в таблице; сегмент по визиту привязывает ответы к месту и устройству.
func (s AnswerScope) Withheld(matched int) bool {
	return s.Segments.VisitSegment() && matched < SegmentK
}
