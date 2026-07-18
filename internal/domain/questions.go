package domain

import "strings"

// Модель вопросов формы «по всем версиям» — одно правило на три экрана: выгрузку
// CSV (csv.go), сводку (summary.go) и воронку (funnel.go).
//
// Правило: форма живёт версиями, и вопрос, удалённый в v3, всё ещё имеет ответы,
// собранные по v1. Показывать только вопросы свежей версии значило бы прятать уже
// собранные данные, поэтому берётся ОБЪЕДИНЕНИЕ блоков по всем версиям. Обход идёт
// от свежей версии к старой: первое появление block_id фиксирует и его позицию
// (свежая раскладка — главная), и подпись (из свежайшей версии, где блок есть).
//
// Вынесено сюда на третьем потребителе: до воронки правило существовало двумя
// копиями (в NewCSVBuilder и NewSummaryBuilder). Копии правила «что считать
// вопросом» опасны тем, что расхождение не падает, а молча показывает владельцу
// РАЗНЫЕ формы на соседних экранах — тот же класс ошибок, что описан в «трёх
// граблях» web/shared/fields/README.md.

// Question — вопрос формы в модели по всем версиям.
type Question struct {
	// ID — стабильный id блока (он же ключ в answers и в form_visits.last_block_id).
	ID string
	// Label — подпись вопроса: label блока, а у безымянного — фолбэк с id.
	Label string
	// Block — блок ИЗ СВЕЖАЙШЕЙ версии, где он встречается. Нужен потребителям,
	// которым мало id и подписи: сводке — тип и диапазон шкалы.
	Block Block
}

// QuestionOrder — вопросы формы в порядке показа. Неотвечаемые блоки (text, image)
// в модель не входят: у них нет ответов, и ни в колонке CSV, ни в шаге воронки им
// делать нечего.
//
// versions ожидаются по возрастанию номера (как их отдаёт forms.Versions).
func QuestionOrder(versions []VersionedSchema) []Question {
	seen := make(map[string]struct{})
	var out []Question
	for i := len(versions) - 1; i >= 0; i-- {
		for _, blk := range versions[i].Schema.Blocks {
			if blk.Type.isContent() {
				continue
			}
			if _, ok := seen[blk.ID]; ok {
				continue
			}
			seen[blk.ID] = struct{}{}
			out = append(out, Question{ID: blk.ID, Label: questionLabel(blk.Label, blk.ID), Block: blk})
		}
	}
	return out
}

// questionLabel — подпись вопроса: label, а для безымянного блока — узнаваемый
// фолбэк с id (пустая колонка/шаг в отчёте хуже некрасивой). Имя без префикса csv:
// правило общее для выгрузки, сводки и воронки, а не свойство формата CSV.
func questionLabel(label, blockID string) string {
	if strings.TrimSpace(label) != "" {
		return label
	}
	return "(без названия) " + blockID
}
