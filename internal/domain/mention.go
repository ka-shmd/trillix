package domain

import (
	"encoding/json"
	"strings"
)

// Подстановка ответов в письме о новом ответе — docs/design/mentions.md §10.
//
// В ТЕКСТЕ ФОРМЫ подстановку делает клиент (@fields/mention.ts), и сервер о ней не
// знает вовсе: PlainText отдаёт имя вопроса, и в CSV с воронкой уезжает оно. ПИСЬМО
// собирает сервер, поэтому здесь живёт вторая реализация того же правила — «чем
// именно подставляется ответ». Расхождение двух реализаций ловит таблица паритета
// (mention_parity_test.go), одинаковая по составу с vitest'ом на фронте.
//
// Разворачивается письмо в момент постановки строки в outbox, а не при доставке: на
// пути приёма схема уже разобрана, а ответ нормализован (скрытое логикой отброшено),
// и диспетчеру пришлось бы идти за обоими.

// MentionAllAnswers — служебный источник «Все ответы»: весь ответ строками
// «вопрос: ответ». Подчерк впереди отделяет его от id блоков навсегда — та же
// договорённость, что у ключей метаколонок выгрузки (_id, _submitted_at).
//
// В тексте блока полотна этот ref инертен (клиент его не знает) — как и любая
// неразрешимая ссылка, он даёт там пустоту, а не ошибку.
const MentionAllAnswers = "_all"

// mentionNoAnswer — то, что стоит в «Все ответы» на месте вопроса, на который не
// ответили (решение владельца 2026-08-30). Вопрос НЕ пропускается: письмо о неполном
// ответе обязано показывать, чего в нём нет, иначе владелец читает пропуск как
// «такого вопроса не было».
const mentionNoAnswer = "без ответа"

// MentionContext — всё, из чего берётся подстановка: вопросы версии, по которой
// пришёл ответ, сами ответы и имена файлов.
type MentionContext struct {
	questions []Question
	byID      map[string]Question
	answers   map[string]json.RawMessage
	files     map[string]AnswerFile
}

// NewMentionContext собирает контекст по ОДНОЙ версии схемы — той, по которой
// отправлен ответ. Объединения версий здесь нет и быть не может: письмо говорит про
// один ответ, и вопросы чужих версий в нём означали бы строки, которых респондент
// не видел.
//
// files нужны только вопросам-файлам и только внутри «Все ответы»; nil — штатное
// значение (форма без файлов либо подстановки, которой файлы не нужны).
func NewMentionContext(schema FormSchema, answers map[string]json.RawMessage, files map[string]AnswerFile) MentionContext {
	qs := QuestionOrder([]VersionedSchema{{Version: 1, Schema: schema}})
	byID := make(map[string]Question, len(qs))
	for _, q := range qs {
		byID[q.ID] = q
	}
	return MentionContext{questions: qs, byID: byID, answers: answers, files: files}
}

// MentionText — плоский текст спанов с развёрнутыми подстановками: тело письма.
//
// Неразрешимая ссылка даёт ПУСТОТУ, а не имя вопроса и не ошибку (mentions.md §4):
// вопроса нет в этой версии, на него не ответили, он скрыт логикой — все случаи
// равны отсутствию ответа. Письмо уходит в любом случае.
func MentionText(spans []Span, ctx MentionContext) string {
	if len(spans) == 0 {
		return ""
	}
	var b strings.Builder
	for _, s := range spans {
		if s.Ref == "" {
			b.WriteString(s.T)
			continue
		}
		b.WriteString(ctx.resolve(s.Ref))
	}
	return b.String()
}

// MentionLine — то же для ТЕМЫ письма: одна строка без переводов.
//
// Чистится и авторский текст, и подстановка, потому что опасны оба: тема уезжает в
// заголовок письма, а ответ респондента — недоверенный ввод. Перевод строки в
// заголовке — это не «некрасиво», а разрыв заголовочной секции.
func MentionLine(spans []Span, ctx MentionContext) string {
	return collapseLines(MentionText(spans, ctx))
}

// MentionsAllAnswers — есть ли в тексте служебная подстановка «Все ответы». Спрашивают
// перед тем, как идти в базу за именами файлов: они нужны только ей.
func MentionsAllAnswers(spans []Span) bool {
	for _, s := range spans {
		if s.Ref == MentionAllAnswers {
			return true
		}
	}
	return false
}

// HasFileQuestion — есть ли в схеме вопрос-файл. Второе условие того же похода в базу.
func HasFileQuestion(schema FormSchema) bool {
	for _, blk := range schema.Blocks {
		if blk.Type == BlockFile {
			return true
		}
	}
	return false
}

func (c MentionContext) resolve(ref string) string {
	if ref == MentionAllAnswers {
		return c.allAnswers()
	}
	q, ok := c.byID[ref]
	if !ok {
		return ""
	}
	return c.answerText(q)
}

// allAnswers — весь ответ строками «вопрос: ответ», в порядке формы.
func (c MentionContext) allAnswers() string {
	lines := make([]string, 0, len(c.questions))
	for _, q := range c.questions {
		v := c.answerText(q)
		if v == "" {
			v = mentionNoAnswer
		}
		lines = append(lines, q.Label+": "+v)
	}
	return strings.Join(lines, "\n")
}

// answerText — ответ в виде текста, который встанет на место чипа. Зеркало
// answerText из @fields/mention.ts, и отличия от ячейки CSV (formatCell) намеренны:
//
//   - несколько вариантов — через «, », а не «; »: в тексте письма точка с запятой
//     читается разделителем предложений, в ячейке таблицы — разделителем значений;
//   - согласие — «Да» либо ПУСТО, а не «Нет»: пустая подстановка и есть отсутствие
//     ответа, а «Нет» посреди фразы было бы утверждением, которого респондент
//     не делал. Строку «без ответа» ставит уже allAnswers, где вопрос назван.
//
// Ошибка разбора даёт пустоту: ответ в JSONB прошёл ValidateAnswers при приёме, но
// версия и тип могли разойтись, и уронить из-за этого письмо нельзя.
func (c MentionContext) answerText(q Question) string {
	raw, ok := c.answers[q.ID]
	if !ok {
		return ""
	}
	switch q.Block.Type {
	case BlockSingleChoice, BlockDropdown:
		var id string
		if json.Unmarshal(raw, &id) != nil {
			return ""
		}
		return optionLabel(blockOptions(q.Block), id)
	case BlockMultiChoice:
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			return ""
		}
		opts := blockOptions(q.Block)
		labels := make([]string, len(ids))
		for i, id := range ids {
			labels[i] = optionLabel(opts, id)
		}
		return strings.Join(labels, ", ")
	case BlockFile:
		// Имена файлов — только внутри «Все ответы»: отдельным источником вопрос-файл
		// в меню не предлагается (design/answer-files.md §9 — имя файла не тот ответ,
		// который имеет смысл подставлять в фразу). Имён нет — вопрос читается как
		// оставшийся без ответа, и это честнее выдуманной строки.
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			return ""
		}
		names := make([]string, 0, len(ids))
		for _, id := range ids {
			if f, ok := c.files[id]; ok {
				names = append(names, f.Name)
			}
		}
		return strings.Join(names, ", ")
	case BlockConsent:
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return ""
		}
		if v == ConsentYes {
			return "Да"
		}
		return ""
	default:
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return ""
		}
		return v
	}
}

// blockOptions — карта «id варианта → подпись». Считается на месте, а не хранится:
// письмо разворачивается один раз на ответ, и карта на десяток вариантов дешевле
// ещё одной структуры рядом с blockView выгрузки.
func blockOptions(blk Block) map[string]string {
	if !blk.Type.isChoice() {
		return nil
	}
	opts := make(map[string]string, len(blk.Settings.Options))
	for _, o := range blk.Settings.Options {
		opts[o.ID] = o.Label
	}
	return opts
}

// collapseLines — тема нормализуется в ОДНУ строку: любой пробельный участок, включая
// перевод строки и возврат каретки, становится одним пробелом, края обрезаются.
// Перевод не удаляется, а заменяется: слова, стоявшие на разных строках, обязаны
// остаться разными словами.
func collapseLines(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
