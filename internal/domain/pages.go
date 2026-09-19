package domain

import (
	"fmt"
	"strings"
)

// Модель страниц формы «по всем версиям» — шаги воронки многостраничной формы.
// Единственная точка правила «что считать страницей»; зеркало подписи — pageName в
// @fields/groups.
//
// Страницы в схеме нет: её выводит splitPages по разрывам. Идентичность страницы между
// версиями — id ОТКРЫВАЮЩЕГО разрыва (на нём же живёт settings.pageName); у первой
// страницы разрыва нет, её ключ — пустая строка.
//
// Вопрос принадлежит странице, на которой он стоит в СВЕЖАЙШЕЙ версии, где он есть, —
// то же правило, по которому QuestionOrder берёт его подпись и позицию. Визит прежней
// версии поэтому засчитывается странице по сегодняшней раскладке: у версий с разным
// делением на страницы общей воронки иначе не собрать, а разрез по версиям показывает
// каждую отдельно.

// Page — страница-шаг воронки.
type Page struct {
	// Key — id открывающего разрыва; "" у первой страницы.
	Key   string
	Label string
	// QuestionIDs — вопросы страницы в порядке показа.
	QuestionIDs []string
}

// PageOrder — страницы формы, на которых есть вопросы, в порядке показа: страницы
// свежей версии по документу, за ними страницы, оставшиеся только в прежних версиях
// (по ним собраны визиты — прятать их значит прятать данные).
//
// nil — форма одностраничная: в свежей версии меньше двух страниц с вопросами. Тогда
// шаги воронки — вопросы, и деление на страницы экрану не нужно.
//
// versions ожидаются по возрастанию номера (как их отдаёт forms.Versions).
func PageOrder(versions []VersionedSchema) []Page {
	if len(versions) == 0 {
		return nil
	}

	byKey := make(map[string]int) // ключ страницы → индекс в out
	assigned := make(map[string]struct{})
	var out []Page
	for i := len(versions) - 1; i >= 0; i-- {
		for n, p := range splitPages(versions[i].Schema.Blocks) {
			key, label := pageIdentity(p, n)
			for _, blk := range p.blocks {
				if !blk.Type.isAnswerable() {
					continue
				}
				if _, ok := assigned[blk.ID]; ok {
					continue
				}
				assigned[blk.ID] = struct{}{}
				idx, ok := byKey[key]
				if !ok {
					idx = len(out)
					byKey[key] = idx
					out = append(out, Page{Key: key, Label: label})
				}
				out[idx].QuestionIDs = append(out[idx].QuestionIDs, blk.ID)
			}
		}
		if i == len(versions)-1 && len(out) < 2 {
			return nil
		}
	}
	return out
}

// pageIdentity — ключ и подпись страницы n (0-based) документа. Номер в подписи — по
// ВСЕМ страницам документа, включая вступление без вопросов: так страницу нумерует
// полотно, и «Страница 3» в воронке обязана быть той же третьей, что видит автор.
func pageIdentity(p page, n int) (key, label string) {
	if p.opener == nil {
		return "", fmt.Sprintf("Страница %d", n+1)
	}
	if name := strings.TrimSpace(p.opener.Settings.PageName); name != "" {
		return p.opener.ID, name
	}
	return p.opener.ID, fmt.Sprintf("Страница %d", n+1)
}
