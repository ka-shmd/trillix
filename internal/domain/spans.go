package domain

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Богатый текст блока (фаза 14, схема v3): плоский массив спанов вместо строки.
// Формат зафиксирован ADR §10 ARCHITECTURE и уточнён там же 2026-07-26 — булевы
// марки списком, значимые своими полями. Обоснование и инварианты —
// docs/design/rich-text.md §2. Зеркало на фронте — spanSchema в
// web/shared/entities/formSchema.ts (правится тем же PR, с тестами обеих сторон).
//
// Почему не дерево: вывод — один .map, валидация здесь — один цикл, выравнивание в
// плоский текст для CSV/воронки/og:description — один join, и нет глубины
// вложенности, которую надо ограничивать.

// Mark — булева марка куска текста. Значимые марки (цвет, фон, ссылка) — поля Span,
// а не элементы этого перечисления: у них есть значение, которому в списке не место.
//
// Список открыт по построению (§1 спеки): новая булева марка — строка сюда, строка в
// validMark, строка в fields.css. Дороже быть не должно.
type Mark string

const (
	MarkBold      Mark = "b"
	MarkItalic    Mark = "i"
	MarkUnderline Mark = "u"
	MarkStrike    Mark = "s"
)

func (m Mark) valid() bool {
	switch m {
	case MarkBold, MarkItalic, MarkUnderline, MarkStrike:
		return true
	default:
		return false
	}
}

// Span — кусок текста с одинаковым оформлением. T непуст: пустой кусок — мусор,
// который пришлось бы тащить через все три поверхности рендера и через join.
type Span struct {
	T     string `json:"t"`
	M     []Mark `json:"m,omitempty"`
	Color string `json:"color,omitempty"`
	BG    string `json:"bg,omitempty"`
	Href  string `json:"href,omitempty"`
	// Ref — подстановка ответа (docs/design/mentions.md): id отвечаемого блока, чей
	// ответ встанет на место этого куска у респондента. Сервер подстановку не делает
	// нигде — она живёт на клиенте, а сюда попадает всё, что читает данные: PlainText
	// отдаёт T, то есть имя вопроса, и в CSV с воронкой уезжает оно.
	Ref string `json:"ref,omitempty"`
}

// PlainText — текст без оформления. Единственный способ, которым богатый текст
// попадает в данные: заголовки CSV, шаги воронки, подписи сводки, og:description,
// aria-label. Разметка в выгрузку не протекает никогда — это демо-критерий фазы, а
// не пожелание.
func PlainText(spans []Span) string {
	if len(spans) == 0 {
		return ""
	}
	if len(spans) == 1 {
		return spans[0].T
	}
	var b strings.Builder
	for _, s := range spans {
		b.WriteString(s.T)
	}
	return b.String()
}

// TextFromString — подъём плоской строки в спаны. Используется апгрейдом v2→v3 и
// тестами; детерминирован и без потерь: пустая строка даёт пустой массив, а не
// массив с пустым куском (одно представление пустоты, §2.3 спеки).
func TextFromString(s string) []Span {
	if s == "" {
		return nil
	}
	return []Span{{T: s}}
}

// isHexColor — строгий `#rrggbb` в нижнем регистре. Свободный CSS в схему не
// пускаем никогда (ADR §10): значение уходит в inline-style рендерера, и хотя React
// его экранирует, произвольная нотация открыла бы место под url(...) и наследие
// expression. Регулярка не берётся ради шести символов — цикл дешевле и яснее.
func isHexColor(s string) bool {
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for i := 1; i < 7; i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// validateSpans — инварианты богатого текста блока (§2.3 спеки).
//
// Два лимита, а не один: как только строка стала массивом, MaxTextLen перестал быть
// лимитом документа — 2000 спанов по одному символу прошли бы проверку длины и
// поехали бы во все три поверхности, в CSV и в воронку. Поэтому длина считается
// суммой по кускам, а число кусков ограничено отдельно.
//
// Склейка соседних одинаково размеченных кусков здесь НЕ требуется: это обязанность
// редактора. Кросс-элементное условие в валидаторе ловило бы 422 на undo и на
// промежуточных состояниях набора, а автосейв обязан хранить недособранное — то же
// решение, что у инертного бита ряда.
func validateSpans(spans []Span) error {
	if len(spans) > MaxSpans {
		return fmt.Errorf("больше %d спанов текста", MaxSpans)
	}
	total := 0
	for i, s := range spans {
		if s.T == "" {
			return fmt.Errorf("спан #%d: пустой текст", i)
		}
		if !utf8.ValidString(s.T) {
			return fmt.Errorf("спан #%d: текст не UTF-8", i)
		}
		total += utf8.RuneCountInString(s.T)

		seen := make(map[Mark]struct{}, len(s.M))
		for _, m := range s.M {
			if !m.valid() {
				return fmt.Errorf("спан #%d: неизвестная марка %q", i, m)
			}
			if _, dup := seen[m]; dup {
				return fmt.Errorf("спан #%d: повторяющаяся марка %q", i, m)
			}
			seen[m] = struct{}{}
		}
		if s.Color != "" && !isHexColor(s.Color) {
			return fmt.Errorf("спан #%d: цвет %q — нужен #rrggbb в нижнем регистре", i, s.Color)
		}
		if s.BG != "" && !isHexColor(s.BG) {
			return fmt.Errorf("спан #%d: фон %q — нужен #rrggbb в нижнем регистре", i, s.BG)
		}
		// Ссылка — единственная марка с угрозой безопасности. Валидатор
		// переиспользуется, а не пишется заново (ADR §10): тот же isHTTPURL, что у
		// redirectUrl, и его зеркало isHttpUrl на фронте.
		if s.Href != "" {
			if n := utf8.RuneCountInString(s.Href); n > MaxRedirectURLLen {
				return fmt.Errorf("спан #%d: ссылка длиннее %d символов", i, MaxRedirectURLLen)
			}
			if !isHTTPURL(s.Href) {
				return fmt.Errorf("спан #%d: ссылка: нужен абсолютный http(s)-адрес", i)
			}
		}
		// Подстановка ответа: проверяется только сам идентификатор. СУЩЕСТВОВАНИЕ
		// блока — нет: неразрешимая ссылка инертна, а не невалидна (mentions.md §4),
		// как условие логики по удалённому вопросу. Кросс-блочная проверка вернула бы
		// 422 автосейву на undo, на промежуточном состоянии драга и на удалении
		// источника — то есть роняла бы правку, которой автор не делал.
		if s.Ref != "" {
			if err := validateID(s.Ref); err != nil {
				return fmt.Errorf("спан #%d: подстановка: %w", i, err)
			}
			// Пара «ссылка наружу + подстановка» не имеет читаемого смысла ни на одной
			// из трёх поверхностей (ADR §10), и разрешив её, смысл пришлось бы
			// определять в каждой.
			if s.Href != "" {
				return fmt.Errorf("спан #%d: ссылка и подстановка вместе", i)
			}
		}
	}
	if total > MaxTextLen {
		return fmt.Errorf("текст длиннее %d символов", MaxTextLen)
	}
	return nil
}
