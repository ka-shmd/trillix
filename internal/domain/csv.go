package domain

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// CSV-экспорт ответов (фаза 6). Чистая сборка табличного представления: ни HTTP,
// ни SQL. Две тонкости продукта живут здесь.
//
// 1. Колонки — объединение блоков по ВСЕМ версиям формы: вопрос, удалённый в v2,
//    остаётся колонкой для ответов v1 (ARCHITECTURE §3.2 — интерпретируемость
//    исторических ответов). Порядок: блоки свежей версии в её порядке, затем
//    «выбывшие» вопросы старых версий; подпись колонки — из самой свежей версии,
//    где блок есть.
// 2. Choice-ответы выгружаются ПОДПИСЯМИ опций, не id, причём подпись берётся из
//    той версии, по которой отправлен ответ (переименование опции в v2 не искажает
//    ответ v1).

// VersionedSchema — снапшот схемы формы с номером версии (вход CSVBuilder).
type VersionedSchema struct {
	Version int
	Schema  FormSchema
}

// Метаколонки идут перед вопросами: id ответа, время, версия формы.
var csvMetaHeader = []string{"ID ответа", "Отправлен", "Версия формы"}

// blockView — то, что нужно от блока при выгрузке: тип, подпись и карта опций
// (id → label) для резолва choice-ответов.
type blockView struct {
	typ     BlockType
	options map[string]string
}

// CSVBuilder строит заголовок и строки CSV по набору версий схемы. Собирается один
// раз на экспорт, затем Row вызывается на каждый ответ (потоково, без накопления).
type CSVBuilder struct {
	columns []string                     // block_id в порядке колонок
	headers []string                     // подписи колонок (мета + вопросы)
	byVer   map[int]map[string]blockView // версия → block_id → вид блока
}

// NewCSVBuilder разбирает версии в модель колонок. versions ожидаются по
// возрастанию номера (как их отдаёт forms.ListFormVersions).
func NewCSVBuilder(versions []VersionedSchema) *CSVBuilder {
	b := &CSVBuilder{byVer: make(map[int]map[string]blockView, len(versions))}

	for _, v := range versions {
		bv := make(map[string]blockView, len(v.Schema.Blocks))
		for _, blk := range v.Schema.Blocks {
			var opts map[string]string
			if blk.Type.isChoice() {
				opts = make(map[string]string, len(blk.Settings.Options))
				for _, o := range blk.Settings.Options {
					opts[o.ID] = o.Label
				}
			}
			bv[blk.ID] = blockView{typ: blk.Type, options: opts}
		}
		b.byVer[v.Version] = bv
	}

	// Колонки — от свежей версии к старой: первое появление block_id фиксирует его
	// позицию (свежая раскладка слева) и подпись (из свежайшей версии с этим блоком).
	seen := make(map[string]struct{})
	b.headers = append(b.headers, csvMetaHeader...)
	for i := len(versions) - 1; i >= 0; i-- {
		for _, blk := range versions[i].Schema.Blocks {
			// Неотвечаемые блоки (text) — не колонки: у них нет ответов.
			if blk.Type.isContent() {
				continue
			}
			if _, ok := seen[blk.ID]; ok {
				continue
			}
			seen[blk.ID] = struct{}{}
			b.columns = append(b.columns, blk.ID)
			b.headers = append(b.headers, csvColumnLabel(blk.Label, blk.ID))
		}
	}
	// Заголовки — тоже пользовательский ввод (label'ы): защищаем от formula injection
	// единообразно с ячейками ответов (мета-константы структурно безопасны — no-op).
	for i := range b.headers {
		b.headers[i] = sanitizeCSVField(b.headers[i])
	}
	return b
}

// Header — строка заголовков CSV (метаколонки + подписи вопросов).
func (b *CSVBuilder) Header() []string { return b.headers }

// Row собирает строку CSV для одного ответа: метаданные + значение каждого вопроса.
// Ячейка пуста, если блока нет в версии ответа или на него не ответили. answers —
// разобранная карта block_id → сырое значение (как хранится в submissions.answers).
func (b *CSVBuilder) Row(id string, createdAt time.Time, version int, answers map[string]json.RawMessage) []string {
	row := make([]string, 0, len(csvMetaHeader)+len(b.columns))
	row = append(row, id, createdAt.UTC().Format(time.RFC3339), strconv.Itoa(version))

	views := b.byVer[version]
	for _, blockID := range b.columns {
		view, inVersion := views[blockID]
		raw, answered := answers[blockID]
		if !inVersion || !answered {
			row = append(row, "")
			continue
		}
		row = append(row, formatCell(view, raw))
	}
	// Защита от CSV formula injection: ответы респондента недоверенны. Мета-ячейки
	// (id, время, версия) структурно безопасны — проход по ним no-op.
	for i := range row {
		row[i] = sanitizeCSVField(row[i])
	}
	return row
}

// formatCell приводит сырое значение ответа к тексту ячейки по типу блока.
// Ошибки разбора не валят экспорт — дают пустую ячейку (данные в JSONB уже
// проходили ValidateAnswers при приёме, но версия/тип могли разойтись).
func formatCell(view blockView, raw json.RawMessage) string {
	switch view.typ {
	case BlockSingleChoice:
		var id string
		if json.Unmarshal(raw, &id) != nil {
			return ""
		}
		return optionLabel(view.options, id)
	case BlockMultiChoice:
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			return ""
		}
		labels := make([]string, len(ids))
		for i, id := range ids {
			labels[i] = optionLabel(view.options, id)
		}
		return strings.Join(labels, "; ")
	default:
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return ""
		}
		return v
	}
}

// optionLabel — подпись опции по id; неизвестный id (рассинхрон версий) выгружается
// как есть, чтобы не потерять факт ответа.
func optionLabel(options map[string]string, id string) string {
	if label, ok := options[id]; ok && label != "" {
		return label
	}
	return id
}

// csvColumnLabel — подпись колонки вопроса: label, а для безымянного блока —
// фолбэк по id (пустой заголовок в таблице бесполезен).
func csvColumnLabel(label, blockID string) string {
	if strings.TrimSpace(label) != "" {
		return label
	}
	return "(без названия) " + blockID
}

// sanitizeCSVField защищает от CSV formula injection: ячейка, начинающаяся с
// = + - @ \t \r, в Excel/Sheets трактуется как формула, а ответ респондента
// недоверенный (пишет аноним, открывает автор — BOM кладётся ради Excel). Префикс
// ' заставляет табличный редактор показать значение как текст. Проверяем первый
// БАЙТ: все триггеры — ASCII, а первый байт многобайтного UTF-8 всегда >= 0x80,
// поэтому кириллица и прочий не-ASCII не затрагиваются. Идемпотентно: результат
// начинается с ', который сам не триггер.
func sanitizeCSVField(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}
