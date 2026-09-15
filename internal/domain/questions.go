package domain

import (
	"fmt"
	"strings"
)

// Модель вопросов формы «по всем версиям» — одно правило на три экрана: выгрузку
// CSV (csv.go), сводку (summary.go) и воронку (funnel.go).
//
// Правило: форма живёт версиями, и вопрос, удалённый в v3, всё ещё имеет ответы,
// собранные по v1. Показывать только вопросы свежей версии значило бы прятать уже
// собранные данные, поэтому берётся ОБЪЕДИНЕНИЕ отвечаемых блоков по всем версиям.
// Обход идёт от свежей версии к старой: первое появление block_id фиксирует и его
// позицию (свежая раскладка — главная), и подпись (из свежайшей версии, где блок
// есть).
//
// Подпись (v2, фаза 8.7) берётся НЕ из самого поля, а из его ГРУППЫ: блок title
// (или label) той же группы. Связь по groupId, а не по позиции — перетаскивание
// не переклеивает подпись на чужой инпут. Нет подписи — генерируется осмысленное
// имя (плейсхолдер, иначе тип+номер), чтобы колонка/шаг не остались безымянными.
//
// Вынесено сюда на третьем потребителе: до воронки правило существовало двумя
// копиями (в NewCSVBuilder и NewSummaryBuilder). Копии правила «что считать
// вопросом» опасны тем, что расхождение не падает, а молча показывает владельцу
// РАЗНЫЕ формы на соседних экранах.

// Question — вопрос формы в модели по всем версиям.
type Question struct {
	// ID — стабильный id отвечаемого блока (он же ключ в answers и в
	// form_visits.last_block_id).
	ID string
	// Label — подпись вопроса: текст title/label его группы, а у безымянного —
	// сгенерированный фолбэк (плейсхолдер/тип+номер).
	Label string
	// Block — отвечаемый блок ИЗ СВЕЖАЙШЕЙ версии, где он встречается. Нужен
	// потребителям, которым мало id и подписи: сводке — тип и диапазон шкалы.
	Block Block
}

// QuestionOrder — вопросы формы в порядке показа. Неотвечаемые блоки (подписи и
// контент) в модель не входят: у них нет ответов, и ни в колонке CSV, ни в шаге
// воронки им делать нечего.
//
// versions ожидаются по возрастанию номера (как их отдаёт forms.Versions).
func QuestionOrder(versions []VersionedSchema) []Question {
	seen := make(map[string]struct{})
	var out []Question
	for i := len(versions) - 1; i >= 0; i-- {
		blocks := versions[i].Schema.Blocks
		caps := groupCaptions(blocks)
		for _, blk := range blocks {
			if blk.Type.isContent() {
				continue
			}
			if _, ok := seen[blk.ID]; ok {
				continue
			}
			seen[blk.ID] = struct{}{}
			out = append(out, Question{
				ID:    blk.ID,
				Label: questionLabel(blk, caps[blk.GroupID], len(out)),
				Block: blk,
			})
		}
	}
	return out
}

// groupCaptions — подпись каждой группы: текст блока title, а при его отсутствии —
// label. title перебивает label независимо от порядка блоков в группе; пустой
// текст подписи не в счёт (не должен глушить осмысленный label или фолбэк). В
// карте — только непустые подписи.
func groupCaptions(blocks []Block) map[string]string {
	caps := make(map[string]string)
	hasTitle := make(map[string]bool)
	for _, b := range blocks {
		// Подпись уходит в заголовки CSV, шаги воронки и подписи сводки — то есть в
		// ДАННЫЕ, куда разметка не протекает никогда (фаза 14): берём плоский текст.
		text := PlainText(b.Text)
		switch b.Type {
		case BlockTitle:
			if strings.TrimSpace(text) != "" && !hasTitle[b.GroupID] {
				caps[b.GroupID] = text
				hasTitle[b.GroupID] = true
			}
		case BlockLabel:
			if !hasTitle[b.GroupID] {
				if _, ok := caps[b.GroupID]; !ok && strings.TrimSpace(text) != "" {
					caps[b.GroupID] = text
				}
			}
		}
	}
	return caps
}

// blockTypeNames — человеческие имена отвечаемых типов для генерации подписи
// безымянного вопроса. Дублирует подписи BLOCK_TYPES фронта, но только для
// фолбэка: забытый тип падает не крашем, а на строковое имя типа.
var blockTypeNames = map[BlockType]string{
	BlockShortText:    "Короткий ответ",
	BlockLongText:     "Длинный ответ",
	BlockEmail:        "Email",
	BlockPhone:        "Телефон",
	BlockNumber:       "Число",
	BlockScale:        "Шкала",
	BlockRating:       "Рейтинг",
	BlockSingleChoice: "Один из списка",
	BlockDropdown:     "Выпадающий список",
	BlockMultiChoice:  "Несколько из списка",
	BlockDate:         "Дата",
	BlockConsent:      "Согласие",
	BlockFile:         "Файл",
	BlockSlot:         "Онлайн-запись",
}

// questionLabel — подпись вопроса по убыванию приоритета: ЯВНОЕ ИМЯ → подпись группы
// (title/label) → собственный текст блока (у consent — текст согласия) →
// плейсхолдер → «Тип N». Пустая колонка/шаг в отчёте хуже сгенерированного имени,
// поэтому безымянного вопроса на экране не бывает. ordinal — 0-based позиция
// вопроса в порядке показа (для «Тип N» человекочитаемо +1).
//
// Имя (фаза 16, ADR §10) — переопределение автора, поэтому оно первое: заголовок
// вопроса пишется для респондента, имя — для данных, и когда автор их развёл, данные
// обязаны слушать имя. Всё остальное — прежний вывод, и он же стоит ПЛЕЙСХОЛДЕРОМ
// поля имени в попапе настроек, чтобы автор видел ровно эту строку до ввода. Зеркало
// вывода на фронте — builder/questionName.ts (правится тем же PR).
//
// Потребители (CSV, сводка, воронка) ходят через QuestionOrder и не меняются. Имя,
// как и подпись, берётся из свежайшей версии, где блок есть, — то есть переименование
// меняет заголовок колонки и для РАНЕЕ собранных ответов. Это сегодняшнее поведение
// подписей, оставленное осознанно (ADR §10).
func questionLabel(blk Block, groupCaption string, ordinal int) string {
	if name := strings.TrimSpace(blk.Name); name != "" {
		return name
	}
	if strings.TrimSpace(groupCaption) != "" {
		return groupCaption
	}
	// Собственный текст блока (у consent — текст согласия) тоже уходит в данные —
	// значит плоским (фаза 14).
	if own := PlainText(blk.Text); strings.TrimSpace(own) != "" {
		return own
	}
	if strings.TrimSpace(blk.Settings.Placeholder) != "" {
		return blk.Settings.Placeholder
	}
	name := blockTypeNames[blk.Type]
	if name == "" {
		name = string(blk.Type)
	}
	return fmt.Sprintf("%s %d", name, ordinal+1)
}
