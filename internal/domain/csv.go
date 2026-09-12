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

// csvMetaColumns — КЛЮЧИ тех же метаколонок. Ключ и подпись — разные вещи:
// подпись человек читает, по ключу интеграция сопоставляет колонку чужой
// таблицы со своей моделью (docs/design/integrations-gsheets.md §8). Подчерк
// впереди отделяет их от id блоков (UUIDv7) навсегда.
var csvMetaColumns = []string{"_id", "_submitted_at", "_form_version"}

// blockView — то, что нужно от блока при выгрузке: тип, подпись и карта опций
// (id → label) для резолва choice-ответов.
type blockView struct {
	typ     BlockType
	options map[string]string
	// files — та же карта, что у строителя: ячейка резолвит id в имя, а вида
	// блока для этого достаточно (тип уже здесь).
	files map[string]AnswerFile
	// zone — пояс расписания формы (фаза 27): в нём пишется время записи. Пусто —
	// у формы нет записи, и ячейка времени не встретится вовсе.
	zone *time.Location
}

// slotTime — время записи человеческим видом в поясе расписания. Неразобранное
// значение отдаётся как есть: ячейка выгрузки не место, где теряют данные.
func (v blockView) slotTime(raw string) string {
	at, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	if v.zone != nil {
		at = at.In(v.zone)
	}
	return at.Format("02.01.2006 15:04")
}

// CSVBuilder строит заголовок и строки CSV по набору версий схемы. Собирается один
// раз на экспорт, затем Row вызывается на каждый ответ (потоково, без накопления).
type CSVBuilder struct {
	columns []string                     // block_id в порядке колонок
	types   []BlockType                  // тип вопроса той же колонки (нужен телу вебхука)
	headers []string                     // подписи колонок (мета + вопросы)
	byVer   map[int]map[string]blockView // версия → block_id → вид блока
	// files — имена приложенных файлов (upload_id → файл), фаза 24. В выгрузке
	// автору нужно ИМЯ, а не id, и уж точно не подпись хранилища: та живёт минуту
	// и протухла бы раньше, чем он откроет скачанный файл.
	files map[string]AnswerFile
	// zone — пояс расписания формы (фаза 27). Отдельным вызовом по тому же доводу,
	// что и файлы: выгрузка формы без записи не должна платить ни запросом, ни
	// памятью.
	zone *time.Location
}

// WithSchedule задаёт пояс, в котором пишется время записи.
func (b *CSVBuilder) WithSchedule(zone *time.Location) *CSVBuilder {
	b.zone = zone
	return b
}

// WithFiles подмешивает имена файлов. Отдельным вызовом, а не аргументом
// конструктора: выгрузка формы без вопросов-файлов не должна платить ни запросом,
// ни памятью — а таких форм подавляющее большинство.
func (b *CSVBuilder) WithFiles(files map[string]AnswerFile) *CSVBuilder {
	b.files = files
	return b
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

	// Колонки — общая модель вопросов по всем версиям (questions.go): выгрузка,
	// сводка и воронка обязаны показывать один и тот же список вопросов.
	b.headers = append(b.headers, csvMetaHeader...)
	for _, q := range QuestionOrder(versions) {
		b.columns = append(b.columns, q.ID)
		b.types = append(b.types, q.Block.Type)
		b.headers = append(b.headers, q.Label)
	}
	return b
}

// Header — строка заголовков CSV (метаколонки + подписи вопросов).
//
// Заголовки — тоже пользовательский ввод (label'ы), поэтому защищаются от
// formula injection единообразно с ячейками ответов. Защита живёт ЗДЕСЬ, а не в
// конструкторе: у выгрузки и у Google Таблиц она разная (там режим вставки RAW,
// и апостроф остался бы видимым символом в ячейке) — см. SheetHeader.
func (b *CSVBuilder) Header() []string { return sanitizeRecord(b.headers) }

// SheetColumn — колонка внешней таблицы: стабильный ключ и подпись, которую
// видит человек. Пара, а не два списка: интеграция хранит порядок колонок листа
// и обязана знать подпись даже для вопроса, которого в форме уже нет (колонка
// удалённого вопроса остаётся — в ней живут ответы прошлых версий).
type SheetColumn struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// SheetColumns — колонки для внешней таблицы: метаколонки, затем вопросы в
// порядке общей модели. Подписи идут БЕЗ CSV-санитайзинга: значения кладутся
// режимом, который их не разбирает, и апостроф остался бы видимым в ячейке.
//
// Сопоставлять колонку с вопросом по ПОДПИСИ нельзя — первое же переименование
// перемешало бы данные, поэтому ключ здесь несущий, а подпись — оформление.
func (b *CSVBuilder) SheetColumns() []SheetColumn {
	out := make([]SheetColumn, 0, len(csvMetaColumns)+len(b.columns))
	for i, key := range csvMetaColumns {
		out = append(out, SheetColumn{Key: key, Label: csvMetaHeader[i]})
	}
	for i, key := range b.columns {
		out = append(out, SheetColumn{Key: key, Label: b.headers[len(csvMetaHeader)+i]})
	}
	return out
}

// Row — строка CSV для одного ответа. Защита от CSV formula injection: ответы
// респондента недоверенны, и открытые в Excel «=…» исполнились бы формулой.
// Мета-ячейки (id, время, версия) структурно безопасны — проход по ним no-op.
func (b *CSVBuilder) Row(id string, createdAt time.Time, version int, answers map[string]json.RawMessage) []string {
	return sanitizeRecord(b.row(id, createdAt, version, answers))
}

// SheetRow — та же строка БЕЗ CSV-санитайзинга: во внешнюю таблицу значения
// кладутся режимом вставки, который их не разбирает (valueInputOption=RAW), и
// апостроф-заглушка осталась бы там видимым символом в ячейке.
func (b *CSVBuilder) SheetRow(id string, createdAt time.Time, version int, answers map[string]json.RawMessage) []string {
	return b.row(id, createdAt, version, answers)
}

// row собирает строку для одного ответа: метаданные + значение каждого вопроса.
// Ячейка пуста, если блока нет в версии ответа или на него не ответили. answers —
// разобранная карта block_id → сырое значение (как хранится в submissions.answers).
func (b *CSVBuilder) row(id string, createdAt time.Time, version int, answers map[string]json.RawMessage) []string {
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
		view.files = b.files
		view.zone = b.zone
		row = append(row, formatCell(view, raw))
	}
	return row
}

// formatCell приводит сырое значение ответа к тексту ячейки по типу блока.
// Ошибки разбора не валят экспорт — дают пустую ячейку (данные в JSONB уже
// проходили ValidateAnswers при приёме, но версия/тип могли разойтись).
func formatCell(view blockView, raw json.RawMessage) string {
	switch view.typ {
	case BlockSingleChoice, BlockDropdown:
		// Одиночный выбор: dropdown хранит ответ так же, как single_choice.
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
	case BlockFile:
		// Файлы: имена через «; », как варианты множественного выбора. Ссылку в
		// выгрузку не кладём — короткая подпись протухнет, а вечная означала бы
		// раздачу чужих персональных данных по ссылке из файла.
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			return ""
		}
		names := make([]string, 0, len(ids))
		for _, id := range ids {
			if f, ok := view.files[id]; ok {
				names = append(names, f.Name)
			}
		}
		return strings.Join(names, "; ")
	case BlockSlot:
		// Время записи — снапшот RFC3339, записанный сервером. В выгрузку идёт
		// человеческим видом в поясе РАСПИСАНИЯ: автор читает свой распорядок, и
		// один и тот же файл, открытый из другого пояса, обязан давать те же числа
		// (решение владельца 2026-09-03).
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return ""
		}
		return view.slotTime(v)
	case BlockConsent:
		// «yes»/пусто — внутренняя кодировка ответа; в выгрузке владельцу нужен
		// человеческий текст.
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return ""
		}
		if v == ConsentYes {
			return "Да"
		}
		return "Нет"
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

// sanitizeCSVField защищает от CSV formula injection: ячейка, начинающаяся с
// = + - @ \t \r, в Excel/Sheets трактуется как формула, а ответ респондента
// недоверенный (пишет аноним, открывает автор — BOM кладётся ради Excel). Префикс
// ' заставляет табличный редактор показать значение как текст. Проверяем первый
// БАЙТ: все триггеры — ASCII, а первый байт многобайтного UTF-8 всегда >= 0x80,
// поэтому кириллица и прочий не-ASCII не затрагиваются. Идемпотентно: результат
// начинается с ', который сам не триггер.
// sanitizeRecord прогоняет запись через защиту от formula injection.
func sanitizeRecord(record []string) []string {
	out := make([]string, len(record))
	for i, f := range record {
		out[i] = sanitizeCSVField(f)
	}
	return out
}

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
