package domain

import "strings"

// NewSchemaIDs выдаёт документу свежие идентификаторы: блокам, вариантам выбора и
// группам. Нужно копированию — форма из шаблона (internal/templates) не должна
// делить `blk_*` с другой формой того же шаблона, иначе ответы, воронка и логика
// двух разных форм ссылались бы на одни и те же строки.
//
// ПЕРЕАДРЕСУЮТСЯ ВСЕ ССЫЛКИ, а не только сами id, и это несущая часть: на id
// ссылаются условия логики (`when.blockId`), цели её действий (`then.targets` —
// вперемешку блоки и варианты), переход на страницу (`then.to` — id разрыва) и
// подстановка ответа в тексте (`span.ref`). Перевыдать id, не тронув ссылки,
// значит отдать автору форму, у которой логика молча ничего не делает.
//
// Ссылка в никуда (цель удалили раньше) остаётся как есть: она и была инертной,
// и подменять её нечем. Неразрешимое правило — законное состояние документа
// (logic.go), поэтому здесь оно не ошибка.
//
// groupId ВЫВОДИТСЯ, а не выдаётся случайно: редактор считает его как «g_» + id
// якоря группы (regroup в builder/store.ts, тот же вывод у ExpandPlan). Сгенерируй
// его от балды — и первое же открытие формы в редакторе переписало бы все группы,
// то есть автосохранение ушло бы с диффом, которого автор не делал.
func NewSchemaIDs(s FormSchema) FormSchema {
	// Блоки и варианты живут в одной карте: цели логики адресуют их вперемешку,
	// и на месте цели неизвестно, что именно там названо.
	ids := make(map[string]string, len(s.Blocks)*2)
	for _, b := range s.Blocks {
		ids[b.ID] = newBlockID()
		for _, o := range b.Settings.Options {
			ids[o.ID] = newOptionID()
		}
	}

	// Группы — второй картой и вторым проходом: их новый id выводится из НОВОГО
	// id якоря, а тот известен только после первого прохода.
	groups := make(map[string]string, len(s.Blocks))
	for _, b := range s.Blocks {
		if b.GroupID == "" {
			continue
		}
		if _, done := groups[b.GroupID]; done {
			continue
		}
		if anchor, ok := strings.CutPrefix(b.GroupID, "g_"); ok {
			if fresh, known := ids[anchor]; known {
				groups[b.GroupID] = groupIDOf(fresh)
				continue
			}
		}
		// Группа, чей id ни на что не указывает (документ старше правила либо
		// якорь удалён): даём свежий — связь блоков внутри группы держит
		// одинаковость значения, а не его происхождение.
		groups[b.GroupID] = groupIDOf(NewID().String())
	}

	out := s
	out.Blocks = make([]Block, len(s.Blocks))
	for i, b := range s.Blocks {
		nb := b
		nb.ID = ids[b.ID]
		if b.GroupID != "" {
			nb.GroupID = groups[b.GroupID]
		}
		if len(b.Settings.Options) > 0 {
			opts := make([]Option, len(b.Settings.Options))
			for j, o := range b.Settings.Options {
				o.ID = ids[o.ID]
				opts[j] = o
			}
			nb.Settings.Options = opts
		}
		nb.Text = remapSpans(b.Text, ids)
		nb.Logic = remapLogic(b.Logic, ids)
		out.Blocks[i] = nb
	}
	return out
}

// remapSpans переадресует подстановки ответа. Копия, а не правка на месте: вызов
// не вправе испортить документ, который ему дали.
func remapSpans(spans []Span, ids map[string]string) []Span {
	if len(spans) == 0 {
		return spans
	}
	out := make([]Span, len(spans))
	copy(out, spans)
	for i := range out {
		if fresh, ok := ids[out[i].Ref]; ok {
			out[i].Ref = fresh
		}
	}
	return out
}

func remapLogic(l *Logic, ids map[string]string) *Logic {
	if l == nil {
		return nil
	}
	out := &Logic{When: remapCondition(l.When, ids)}
	if len(l.Then) > 0 {
		out.Then = make([]LogicAction, len(l.Then))
		for i, a := range l.Then {
			na := a
			if len(a.Targets) > 0 {
				na.Targets = make([]string, len(a.Targets))
				for j, t := range a.Targets {
					na.Targets[j] = remapID(t, ids)
				}
			}
			na.To = remapID(a.To, ids)
			out.Then[i] = na
		}
	}
	return out
}

func remapCondition(c *Condition, ids map[string]string) *Condition {
	if c == nil {
		return nil
	}
	out := *c
	out.BlockID = remapID(c.BlockID, ids)
	// Value — ответ в том виде, в каком он хранится: у выбора это ID ВАРИАНТА,
	// у прочих типов число или строка. Карта решает сама: чужого в ней нет,
	// и «5» проходит мимо, потому что таких ключей в ней не бывает.
	out.Value = remapID(c.Value, ids)
	// ValueRef — id БЛОКА, чей ответ стоит в правой части («больше, чем стоимость»).
	// Не переадресовать его значит отдать копию, где половина условий смотрит на
	// вопросы формы-оригинала: правило не падает, оно молча становится инертным.
	out.ValueRef = remapID(c.ValueRef, ids)
	out.All = remapConditions(c.All, ids)
	out.Any = remapConditions(c.Any, ids)
	return &out
}

func remapConditions(in []Condition, ids map[string]string) []Condition {
	if len(in) == 0 {
		return in
	}
	out := make([]Condition, len(in))
	for i := range in {
		out[i] = *remapCondition(&in[i], ids)
	}
	return out
}

func remapID(id string, ids map[string]string) string {
	if fresh, ok := ids[id]; ok {
		return fresh
	}
	return id
}
