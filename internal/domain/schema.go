package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"unicode/utf8"
)

// Схема формы — единый контракт двух сторон: эти Go-типы и зеркальная Zod-схема
// web/shared/entities/formSchema.ts. Любая правка формата (тип блока, лимит,
// поле) меняется в обоих местах одним PR с тестами обеих сторон (web/CLAUDE.md).
//
// Хранится как один JSONB-документ (ARCHITECTURE 3.4): реляционные запросы внутрь
// схемы не нужны, форма всегда читается и пишется целиком. Валидируется на уровне
// приложения строгими типами — БД про структуру блоков не знает.
//
// Модель v2 (фаза 8.7): вопрос — не один блок, а ГРУППА блоков с общим groupId
// (подпись title/label + отвечаемое поле + контент между ними). Подпись живёт
// отдельным блоком, поэтому у поля своего текста нет — кроме consent, у которого
// текст согласия интринсик контрола (рендерится рядом с галочкой).

// SchemaVersion — версия формата, ЗАМОРОЖЕННАЯ на единице до релиза (решение
// владельца 2026-08-10).
//
// Правило до релиза: формат меняется в лоб, документы в БД чинятся одноразовой
// правкой в том же PR, номер не двигается. Апгрейдеров формата на чтении НЕТ и
// заводить их не нужно: пользователей ещё нет, а сопровождать конвертеры ради
// данных, которых нет, дороже, чем починить базу разово. Поле остаётся петлёй под
// первую настоящую миграцию после релиза — завести его заново дороже, чем держать
// здесь. Зеркалит SCHEMA_VERSION в formSchema.ts.
const SchemaVersion = 1

// Лимиты схемы. Верхние границы — защита от раздутого документа; длины строк
// считаются в рунах. Заведомо просторны для нормальной анкеты, но конечны.
const (
	MaxBlocks  = 200
	MaxOptions = 100
	// MaxTextLen — суммарная длина текста блока по всем спанам (title/label/heading/
	// text/consent). Число то же, что было у строки в v2: текст не стал длиннее от
	// того, что его покрасили.
	MaxTextLen = 2000
	// MaxSpans — число кусков в тексте одного блока. Второй лимит обязателен: без
	// него MaxTextLen перестал быть лимитом документа в тот момент, когда строка
	// стала массивом (см. validateSpans).
	MaxSpans = 200
	// MaxFormTitleLen — длина заголовка ФОРМЫ (блок form_title). Не MaxTextLen:
	// заголовок уезжает зеркалом в forms.title, оттуда — в <title>, og:title и в
	// потолок поискового запроса, поэтому у него свой, более тесный лимит. Число
	// то же, что у maxTitleLen в forms (и с фазы 15 — те же единицы, руны).
	MaxFormTitleLen   = 200
	MaxOptionLabelLen = 500
	MaxIDLen          = 64
	MaxSubmitLabelLen = 100
	MaxPlaceholderLen = 200
	MaxImageKeyLen    = 200
	// MaxQuestionNameLen — длина ИМЕНИ вопроса (Block.Name, фаза 16): строки, которой
	// вопрос называется в данных — заголовок колонки CSV, подпись шага воронки, ключ
	// сводки. Не MaxTextLen: это короткий идентификатор для аналитики, а не текст
	// вопроса (тот живёт в подписи и ограничен своим лимитом).
	MaxQuestionNameLen = 100
	// Границы диапазона шкалы. Верх — 10: шкала это ряд кнопок, а не поле ввода;
	// на телефоне больше десяти в строку не помещается (нужно число — есть number).
	// Низ — 0: NPS считается от нуля.
	ScaleLowerBound = 0
	ScaleUpperBound = 10
	// Диапазон новой шкалы и фолбэк для схемы без него. Зеркалят DEFAULT_SCALE_*.
	DefaultScaleMin = 1
	DefaultScaleMax = 5
	// Экран «после отправки»: текст благодарности владельца и ссылка перехода.
	MaxThankYouTextLen = 2000
	MaxRedirectURLLen  = 2000
	// MaxCustomCSSLen — потолок своего CSS формы (фаза 22, слайс 7), в рунах. Лимит
	// не «на всякий случай»: разобрать этот CSS мы не можем (свой парсер в Go — не та
	// цена и не та зависимость), значит единственные доступные меры — объём, тариф и
	// правило-сторож после авторского текста. Десять тысяч рун — это лист вёрстки,
	// но не тема WordPress, приехавшая целиком в JSONB схемы.
	MaxCustomCSSLen = 10000
	// MaxBlockClassLen — длина своего имени блока. Держится вместе с регуляркой ниже:
	// имя короткое по построению, и лимит здесь — чтобы сообщение об ошибке называло
	// число, а не отсылало к регулярке.
	MaxBlockClassLen = 32
)

// MaxColumns — колонок в одном ряду (секции). Зеркалит MAX_COLUMNS в limits.ts.
//
// До 2026-08-10 колонок было ровно две ("left"/"right" у того же ключа), и упиралось
// это не в раскладчик, а в число значений: ряд из трёх элементов был невыразим.
// Потолок — про ВИД: при ширине формы 700px четыре колонки дают по 154px, и это
// последнее число, при котором в колонку помещается короткое поле с подписью. Что
// читается в такой колонке, решает автор формы (ADR §10).
const MaxColumns = 4

// BlockType — тип блока формы. Три семьи: отвечаемые поля (собирают ответ),
// подписи (title/label — текст вопроса в группе) и контент (heading/text/image —
// оформление). Подписи и контент неотвечаемы (isContent): исключены из
// ValidateAnswers и CSV. consent — отвечаемый, но несёт собственный текст.
type BlockType string

const (
	// Отвечаемые.
	BlockShortText    BlockType = "short_text"
	BlockLongText     BlockType = "long_text"
	BlockEmail        BlockType = "email"
	BlockPhone        BlockType = "phone"
	BlockNumber       BlockType = "number"
	BlockScale        BlockType = "scale"
	BlockSingleChoice BlockType = "single_choice"
	BlockDropdown     BlockType = "dropdown"
	BlockMultiChoice  BlockType = "multi_choice"
	BlockDate         BlockType = "date"
	BlockConsent      BlockType = "consent"
	// Подписи (текст вопроса в группе).
	BlockTitle BlockType = "title"
	BlockLabel BlockType = "label"
	// Контент (оформление).
	BlockHeading BlockType = "heading"
	BlockText    BlockType = "text"
	BlockImage   BlockType = "image"
	// Разрыв страницы (фаза 19): граница между страницами формы. Неотвечаемый, как
	// прочий контент; страница сущностью схемы не является — её выводит раскладчик
	// фронта (splitPages), как groupId выводит regroup. Go про страницы не знает
	// вовсе: ответ приходит одним запросом со всех страниц сразу, поэтому ни приём,
	// ни валидация ответов разбиения не видят. Зеркалит 'page_break' в contract.ts.
	BlockPageBreak BlockType = "page_break"
	// Заголовок ФОРМЫ (фаза 15): первая строка документа, <h1> у респондента.
	// Отдельный тип, а не BlockTitle: тот — подпись ВОПРОСА, из которой аналитика
	// берёт имя колонки и шага воронки. Слить их значило бы навсегда объяснять,
	// почему один title попадает в CSV, а другой нет.
	BlockFormTitle BlockType = "form_title"
)

// blockTypes — все типы блоков одним списком, и он же источник valid().
//
// До фазы 16 состав перечисляли ДВА места: switch в valid() и (с этапа 16.1а) тест
// паритета с реестром фронта. Второй список молча отставал от первого: тип, добавленный
// в Go и забытый в тесте, паритет проходил — а фронт такой документ отвергал целиком
// (z.enum), то есть опубликованная схема перестала бы разбираться у респондента. Найдено
// ревью этапа 16.1а. Список остаётся рукописным (ADR §10: Go предикатный, реестр фронта
// он импортировать не может), но он ОДИН.
var blockTypes = []BlockType{
	// отвечаемые
	BlockShortText, BlockLongText, BlockEmail, BlockPhone, BlockNumber, BlockScale,
	BlockSingleChoice, BlockDropdown, BlockMultiChoice, BlockDate, BlockConsent,
	// подписи
	BlockTitle, BlockLabel,
	// контент, разрыв страницы и заголовок формы
	BlockHeading, BlockText, BlockImage, BlockPageBreak, BlockFormTitle,
}

func (t BlockType) valid() bool { return slices.Contains(blockTypes, t) }

// isChoice — у choice-типов настройки несут список опций; у остальных settings пуст.
// dropdown отличается от single_choice ТОЛЬКО контролом на фронте: та же модель
// опций, тот же формат ответа.
func (t BlockType) isChoice() bool {
	return t == BlockSingleChoice || t == BlockDropdown || t == BlockMultiChoice
}

// isSingleChoice — выбор ровно одного варианта (ответ — строка-id), в отличие от
// multi_choice (массив id). Отдельный предикат, а не сравнение с BlockSingleChoice:
// забытый здесь dropdown молча уехал бы в ветку multi и ждал массив.
func (t BlockType) isSingleChoice() bool {
	return t == BlockSingleChoice || t == BlockDropdown
}

// isMultiChoice — выбор нескольких вариантов (ответ — массив id). Выводится из двух
// предикатов выше, а не перечисляет типы: новый множественный choice-тип не придётся
// вспоминать в третьем месте.
func (t BlockType) isMultiChoice() bool { return t.isChoice() && !t.isSingleChoice() }

// isCaption — блок-подпись группы (title/label): его text — подпись вопроса, из
// которой аналитика берёт имя колонки/шага. Крупная (title) против мелкой (label)
// — только вид, семантика одна.
func (t BlockType) isCaption() bool {
	return t == BlockTitle || t == BlockLabel
}

// isContent — неотвечаемый блок: подписи (title/label), контент (heading/text/
// image) и заголовок формы. Не собирает ответ: исключён из ValidateAnswers, CSV и
// модели вопросов. Забыть здесь новый тип — значит молча сделать его отвечаемым:
// у формы появится колонка в выгрузке и шаг воронки, которых автор не создавал.
func (t BlockType) isContent() bool {
	return t == BlockTitle || t == BlockLabel || t == BlockHeading || t == BlockText ||
		t == BlockImage || t == BlockPageBreak || t == BlockFormTitle
}

// isAnswerable — блок собирает ответ (все отвечаемые типы, включая consent).
func (t BlockType) isAnswerable() bool { return !t.isContent() }

// carriesText — тип несёт собственное поле text: подписи, контентные абзацы/
// заголовки, заголовок формы и consent (текст согласия рядом с галочкой). У прочих
// отвечаемых (и у image) поле text обязано быть пустым.
func (t BlockType) carriesText() bool {
	return t == BlockTitle || t == BlockLabel || t == BlockHeading || t == BlockText ||
		t == BlockConsent || t == BlockFormTitle
}

// canShareRow — типу разрешено делить ряд (ADR §10). Разрешено ВСЕМ, кроме заголовка
// формы: решение владельца 2026-07-29 отменило прежний whitelist коротких контролов
// (short_text/email/phone/number/date/dropdown, фаза 13.6). Довод whitelist'а был про
// читаемость половинной колонки — то есть про вид, за который отвечает автор формы, а
// не схема; заодно он ронял случаи, о которых ничего не говорил (лэйаут-блок в ряд не
// вставал вовсе). Заголовок формы исключён по устройству, а не по виду: он рисуется
// вне потока вопросов, и соседей по ряду у него не бывает. Зеркалит canShareRow в
// formSchema.ts.
// Разрыв страницы (фаза 19) исключён по той же причине, что заголовок формы, — по
// устройству, а не по виду: он граница раскладки, а не её элемент, и половина ряда, за
// которой начинается новая страница, не значит ничего.
func (t BlockType) canShareRow() bool { return t != BlockFormTitle && t != BlockPageBreak }

// Option — вариант выбора у choice-блока. id стабилен и генерируется на клиенте
// один раз: ответы ссылаются на него, поэтому переименование label связь не рвёт.
type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Column — тот же НОМЕР КОЛОНКИ, что у блока (спека §5.1): 1..MaxColumns =
	// «я в этой колонке текущего ряда», 0 (пусто) = свой ряд во всю ширину. У опций
	// dropdown инертен (список живёт в нативном select) — и потому не запрещён, как
	// и любой другой флаг, которому некуда примениться.
	Column int `json:"column,omitempty"`
	// VisibleIf — условие показа ВАРИАНТА (фаза 21, каскадные списки): то же дерево,
	// что у вопроса, носитель — сам вариант. Позиция носителя для «ссылка смотрит
	// назад» — позиция его блока: вариант живёт там же, где список. См. logic.go.
	VisibleIf *Condition `json:"visibleIf,omitempty"`
}

// BlockSettings — типоспецифичные настройки блока: options у choice-типов,
// placeholder у текстовых полей ввода, imageKey у типа image, диапазон у scale.
//
// ScaleMin/ScaleMax — указатели, а не int: 0 — законный минимум шкалы (NPS 0–10),
// и с `omitempty` нулевое значение вылетало бы из JSON, а «не задано» было бы
// неотличимо от «задано 0». Оба nil — недособранный черновик (допустим, как choice
// без опций); задан ровно один — ошибка.
type BlockSettings struct {
	Options     []Option `json:"options,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	ImageKey    string   `json:"imageKey,omitempty"`
	ScaleMin    *int     `json:"scaleMin,omitempty"`
	ScaleMax    *int     `json:"scaleMax,omitempty"`
	// Column — НОМЕР КОЛОНКИ ряда (спека §5): 1..MaxColumns читается как «я в этой
	// колонке текущего ряда», 0 (пусто) = свой ряд во всю ширину и конец секции.
	// Ширина не хранится вовсе — её выводит раскладчик. Только у canShareRow-типов.
	//
	// Нумерация с единицы — из-за `omitempty`: нулевой индекс исчез бы при
	// сериализации, и первая колонка стала бы полной шириной.
	//
	// Кросс-блочное условие «соседняя колонка существует и умеет делить ряд» здесь
	// НЕ проверяется намеренно: флаг, которому некуда примениться, инертен и
	// легален, иначе undo и промежуточные состояния драга ловили бы 422.
	Column int `json:"column,omitempty"`
}

// Block — один блок формы. GroupID связывает блоки одного вопроса (ARCHITECTURE
// 3.4): вопрос — группа блоков подряд с общим groupId, в которой не более одного
// отвечаемого блока. Text несут только carriesText-типы; у отвечаемых полей
// (кроме consent) он пуст — подпись живёт в блоке title/label той же группы.
//
// Text — богатый текст (v3): плоский массив спанов, см. spans.go. Плоскую строку для
// данных даёт PlainText.
// Name — имя вопроса (фаза 16, ADR §10): необязательное ПЕРЕОПРЕДЕЛЕНИЕ строки,
// которой вопрос называется в данных. Пусто — имя выводится как раньше
// (questionLabel). Верхний уровень, а не Settings: свойство любого отвечаемого
// блока, а не типа.
// Правила условной логики (фаза 21) — верхний уровень блока, а не Settings: это
// свойство любого блока, а не типа (тот же довод, что у Name). Формат, семантика и
// причина, по которой ссылки не валидируются, — logic.go.
type Block struct {
	ID       string        `json:"id"`
	GroupID  string        `json:"groupId"`
	Type     BlockType     `json:"type"`
	Text     []Span        `json:"text,omitempty"`
	Name     string        `json:"name,omitempty"`
	Required bool          `json:"required,omitempty"`
	Settings BlockSettings `json:"settings"`
	// VisibleIf — условие показа ВОПРОСА ЦЕЛИКОМ; читается с ГОЛОВНОГО блока группы
	// (подпись, поле и контент прячутся вместе), как бит ряда. На любом другом блоке
	// группы инертно — по той же причине, по которой не валидируется бит: голова
	// меняется драгом и удалением подписи.
	VisibleIf *Condition `json:"visibleIf,omitempty"`
	// RequiredIf — условная обязательность отвечаемого блока. Взаимоисключающа с
	// Required: обязательность это три состояния (нет / всегда / по условию).
	RequiredIf *Condition `json:"requiredIf,omitempty"`
	// JumpIf — переходы со страницы, которую закрывает ЭТОТ разрыв; только у
	// page_break. Порядок = приоритет.
	JumpIf []JumpRule `json:"jumpIf,omitempty"`
	// Class — СВОЁ имя блока для CSS автора (фаза 22, слайс 7). Уезжает в атрибут
	// class рядом с нашими rf-*, и по нему автор пишет правило в design.css.
	//
	// Своё имя, а не наши внутренние классы, — осознанный выбор: селектор вида
	// `.rf-input` привязал бы автора к устройству нашей вёрстки и запретил бы нам её
	// менять (публичным контрактом объявлено УЗКОЕ подмножество, спека §10.6).
	// Собственное имя даёт ту же свободу, ничего не обещая сверх.
	//
	// Одно имя, а не список: пробел в значении открыл бы дорогу к «своим» именам
	// вроде `rf-input` вперемешку с чужими, а разбор списка — к вопросу, что делать
	// с дублями. Нужен второй признак — второй блок или второе правило.
	Class string `json:"class,omitempty"`
}

// FormSchema — документ черновика формы: версия формата, список блоков, текст
// кнопки отправки и настройки экрана «после отправки» (пусто → рендерер берёт
// дефолты).
//
// Экран «после отправки» живёт в схеме, а не в колонках forms, осознанно: схема
// снапшотится при публикации, поэтому респондент видит экран той версии, по
// которой отправил ответ. Настройка, обязанная быть живой (лимит мест, фаза 8.5
// шаг 4), напротив, в схеме жить не должна.
type FormSchema struct {
	SchemaVersion int     `json:"schemaVersion"`
	Blocks        []Block `json:"blocks"`
	SubmitLabel   string  `json:"submitLabel"`
	ThankYouText  string  `json:"thankYouText"`
	RedirectURL   string  `json:"redirectUrl"`
	// Оформление страницы (хром, а не блоки полотна) — cover.go. Указатели, а не
	// значения: «обложки нет» и «обложка задана пустой» обязаны быть разными
	// состояниями, иначе валидатору нечего отвергать.
	Cover *FormCover `json:"cover,omitempty"`
	Logo  *FormLogo  `json:"logo,omitempty"`
	// Оформление страницы (тема, цвета, шрифт, лэйаут, свой CSS) — design.go.
	// Указатель по той же причине: «оформление не трогали» и «оформление сброшено в
	// дефолт» — разные состояния документа, и различает их только наличие объекта.
	Design *FormDesign `json:"design,omitempty"`
}

// ValidateSchema строго разбирает и проверяет JSONB-документ схемы формы.
//
// Цепочки апгрейдов на чтении здесь БОЛЬШЕ НЕТ (решение владельца 2026-08-10):
// до релиза формат меняется в лоб, а документы в БД чинятся одноразовой правкой в том
// же PR. Версия ниже текущей — это документ, не пережившей такой правки, и молча
// прочитать его нельзя: отвергаем.
//
// Лишние поля запрещены (DisallowUnknownFields) — расхождение контракта ловится
// сразу, а не оседает мусором в JSONB. Все нарушения возвращаются как
// ErrValidation (→ 422 в respond.go), чистая функция без HTTP и SQL.
//
// Это валидатор *черновика* билдера: пустой текст подписи и choice без опций
// допустимы — это нормальное недособранное состояние, которое автосейв обязан
// уметь хранить. Правила момента ПУБЛИКАЦИИ в проекте нет вовсе: гейт, введённый
// фазой 16, снят решением владельца (ADR §10), и обещание «непустая подпись,
// ≥1 опция», стоявшее здесь с фазы 4, больше не даётся — форма публикуется в
// любом состоянии.
func ValidateSchema(raw json.RawMessage) (FormSchema, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()

	var s FormSchema
	if err := dec.Decode(&s); err != nil {
		return FormSchema{}, schemaErr("не удалось разобрать схему: %v", err)
	}
	if dec.More() {
		return FormSchema{}, schemaErr("лишние данные после схемы")
	}

	// Отсутствие версии трактуем как текущую: дефолт БД — '{"blocks":[]}' без поля,
	// и он обязан оставаться валидным документом пустой формы.
	if s.SchemaVersion == 0 {
		s.SchemaVersion = SchemaVersion
	}
	if s.SchemaVersion != SchemaVersion {
		return FormSchema{}, schemaErr("неизвестная schemaVersion %d", s.SchemaVersion)
	}

	// Потолок считает блоки, которые добавил АВТОР; заголовок формы в счёт не идёт —
	// он часть скелета документа, а не элемент, который автор ставил. Иначе форма,
	// собранная до фазы 15 ровно на потолке, после синтеза заголовка получала бы 201
	// блок и переставала сохраняться совсем: автор открыл её, а автосейв молча
	// отвечает 422 на документ, который дописал сам сервер.
	if n := len(s.Blocks); n > MaxBlocks {
		if _, spoke := FormTitle(s); !spoke || n > MaxBlocks+1 {
			return FormSchema{}, schemaErr("больше %d блоков", MaxBlocks)
		}
	}
	if n := utf8.RuneCountInString(s.SubmitLabel); n > MaxSubmitLabelLen {
		return FormSchema{}, schemaErr("submitLabel длиннее %d символов", MaxSubmitLabelLen)
	}
	if n := utf8.RuneCountInString(s.ThankYouText); n > MaxThankYouTextLen {
		return FormSchema{}, schemaErr("thankYouText длиннее %d символов", MaxThankYouTextLen)
	}
	if n := utf8.RuneCountInString(s.RedirectURL); n > MaxRedirectURLLen {
		return FormSchema{}, schemaErr("redirectUrl длиннее %d символов", MaxRedirectURLLen)
	}
	// Схема redirect проверяется строго даже в черновике (в отличие от пустого
	// текста): билдер коммитит поле в стор только по blur, поэтому недопечатанный
	// URL до автосейва не доезжает и 422 посреди набора не бывает.
	if s.RedirectURL != "" && !isHTTPURL(s.RedirectURL) {
		return FormSchema{}, schemaErr("redirectUrl: нужен абсолютный http(s)-адрес")
	}
	if err := validateCover(s.Cover); err != nil {
		return FormSchema{}, schemaErr("%s", err)
	}
	if err := validateLogo(s.Logo); err != nil {
		return FormSchema{}, schemaErr("%s", err)
	}
	if err := validateDesign(s.Design); err != nil {
		return FormSchema{}, schemaErr("%s", err)
	}

	if err := validateGroups(s.Blocks); err != nil {
		return FormSchema{}, err
	}
	if err := validateFormTitle(s.Blocks); err != nil {
		return FormSchema{}, err
	}

	seen := make(map[string]struct{}, len(s.Blocks))
	for i := range s.Blocks {
		if err := validateBlock(i, s.Blocks[i], seen); err != nil {
			return FormSchema{}, err
		}
	}
	return s, nil
}

// CanonicalV4 приводит сырую схему к каноническому v4-JSON: апгрейд цепочкой
// v1→v2→v3→v4 и валидация. Нужна на отдаче фронту, который знает только текущий формат
// (рендерер читает опубликованную версию, кабинет — черновик, и обе в БД могут быть
// ещё v1/v2/v3). Идемпотентна на уже-v4. Ошибка означает битую схему в БД — наружу как есть.
func CanonicalV4(raw json.RawMessage) (json.RawMessage, error) {
	s, err := ValidateSchema(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(s)
}

// FormTitle — заголовок формы из ДОКУМЕНТА: плоский текст блока form_title и
// признак «документ о заголовке высказался» (фаза 15, спека §3.4).
//
// Два возврата, а не один, потому что «блока нет» и «блок пуст» — разные вещи, и
// путать их нельзя. НЕТ блока — документ снят до фазы 15, заголовок живёт только в
// колонке forms.title, и звать её обязательно. ПУСТ — автор стёр заголовок
// намеренно, и колонку звать НЕЛЬЗЯ: оттуда респонденту утекло бы служебное
// «Untitled form». Ровно эта утечка и была до фазы.
func FormTitle(s FormSchema) (string, bool) {
	for _, b := range s.Blocks {
		if b.Type == BlockFormTitle {
			return PlainText(b.Text), true
		}
	}
	return "", false
}

// EnsureFormTitle возвращает схему с блоком заголовка: если документ о заголовке
// ещё не говорил, блок дописывается ПЕРВЫМ с текстом title (фаза 15, спека §3.5).
// Так заголовок переезжает из колонки в документ — на чтении черновика кабинетом,
// а не миграцией БД: апгрейд формата видит только JSON, а заголовок лежит в
// соседней таблице.
//
// Id детерминирован (ft_<id формы>, groupId — g_<id блока>, как выводит regroup на
// клиенте): случайный id означал бы новый блок на каждый заход в билдер, лишний
// дифф автосейва и лишний PATCH. Пустой title даёт блок с пустым текстом — это
// законное состояние черновика, а не «заголовка нет».
func EnsureFormTitle(s FormSchema, title, formID string) FormSchema {
	if _, spoke := FormTitle(s); spoke {
		return s
	}
	id := "ft_" + formID
	block := Block{ID: id, GroupID: "g_" + id, Type: BlockFormTitle, Text: TextFromString(title)}
	out := s
	out.Blocks = append([]Block{block}, s.Blocks...)
	return out
}

// CanonicalDraftV4 — канон черновика ДЛЯ КАБИНЕТА: апгрейд, синтез заголовка из
// колонки (EnsureFormTitle) и обратно в JSON. Отдельно от CanonicalV4, потому что
// синтез уместен ровно на одном пути: редактор обязан увидеть заголовок строкой
// полотна. Публичный путь ходит через CanonicalV4 — там документ снят публикацией
// и дописывать в него ничего нельзя.
func CanonicalDraftV4(raw json.RawMessage, title, formID string) (json.RawMessage, error) {
	s, err := ValidateSchema(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(EnsureFormTitle(s, title, formID))
}

// validateGroups проверяет структуру групп: у каждого блока непустой groupId,
// блоки одной группы идут ПОДРЯД (группа не разорвана чужими блоками) и в группе
// не более одного отвечаемого блока. Смежность несёт вид: рендерер и редактор
// раскладывают группу как непрерывный вопрос, а разорванная группа означала бы
// подпись без поля посреди чужого вопроса.
func validateGroups(blocks []Block) error {
	answerable := make(map[string]int)
	endedRun := make(map[string]struct{}) // группы, чей смежный участок уже закрылся
	prev := ""
	for i, b := range blocks {
		if err := validateID(b.GroupID); err != nil {
			return schemaErr("блок #%d: groupId: %s", i, err)
		}
		if b.GroupID != prev {
			if _, ended := endedRun[b.GroupID]; ended {
				return schemaErr("блок #%d: группа %q не смежна (блоки группы разорваны)", i, b.GroupID)
			}
			if prev != "" {
				endedRun[prev] = struct{}{}
			}
			prev = b.GroupID
		}
		if b.Type.isAnswerable() {
			answerable[b.GroupID]++
			if answerable[b.GroupID] > 1 {
				return schemaErr("блок #%d: в группе %q больше одного отвечаемого блока", i, b.GroupID)
			}
		}
	}
	return nil
}

// validateFormTitle — инварианты заголовка формы (фаза 15, спека §3.2): он один,
// он первая строка документа и он всегда одиночка. Отсутствие блока законно:
// версии, опубликованные до v4, заголовка в схеме не несут вовсе, а редактор
// синтезирует его из колонки при чтении черновика.
//
// «Первый» — не косметика: заголовок рисуется как <h1> формы, и блок, оказавшийся
// посреди вопросов, означал бы второй <h1> в середине страницы у респондента.
// «Одиночка» держит regroup честным: попади form_title в группу поля, редактор
// стал бы показывать заголовок формы подписью вопроса.
func validateFormTitle(blocks []Block) error {
	seen := false
	for i, b := range blocks {
		if b.Type != BlockFormTitle {
			continue
		}
		if seen {
			return schemaErr("блок #%d: заголовок формы может быть только один", i)
		}
		seen = true
		if i != 0 {
			return schemaErr("блок #%d: заголовок формы должен быть первым блоком", i)
		}
		if n := utf8.RuneCountInString(PlainText(b.Text)); n > MaxFormTitleLen {
			return schemaErr("блок #%d: заголовок формы длиннее %d символов", i, MaxFormTitleLen)
		}
		for j, other := range blocks {
			if j != i && other.GroupID == b.GroupID {
				return schemaErr("блок #%d: заголовок формы не входит в группу вопроса", i)
			}
		}
	}
	return nil
}

func validateBlock(i int, b Block, seenIDs map[string]struct{}) error {
	at := fmt.Sprintf("блок #%d", i)

	if err := validateID(b.ID); err != nil {
		return schemaErr("%s: id: %s", at, err)
	}
	if _, dup := seenIDs[b.ID]; dup {
		return schemaErr("%s: повторяющийся id %q", at, b.ID)
	}
	seenIDs[b.ID] = struct{}{}

	if !b.Type.valid() {
		return schemaErr("%s: неизвестный тип %q", at, b.Type)
	}
	if err := validateSpans(b.Text); err != nil {
		return schemaErr("%s: %s", at, err)
	}
	// Собственный text — только у carriesText-типов (подписи, контент, consent);
	// у прочих подпись живёт отдельным блоком.
	if !b.Type.carriesText() && len(b.Text) > 0 {
		return schemaErr("%s: тип %q не несёт собственного текста", at, b.Type)
	}
	// Имя — только у отвечаемых: у подписи и контента нет ответов, значит нет ни
	// колонки CSV, ни шага воронки, которые оно называет. Пустая строка законна и
	// означает «имя не задано» (канон её не хранит — omitempty).
	if n := utf8.RuneCountInString(b.Name); n > MaxQuestionNameLen {
		return schemaErr("%s: имя вопроса длиннее %d символов", at, MaxQuestionNameLen)
	}
	if b.Name != "" && !b.Type.isAnswerable() {
		return schemaErr("%s: тип %q не собирает ответ и не имеет имени", at, b.Type)
	}
	// Своё имя блока для CSS автора: строгая форма, а не «любая строка». Значение
	// уходит в атрибут class, и в нём не должно быть ни пробела (второй класс —
	// второе имя), ни заглавных (CSS-селекторы регистрозависимы в атрибуте, и пара
	// `.Foo`/`.foo` дала бы автору невоспроизводимое поведение), ни чего-либо, чем
	// можно разорвать атрибут.
	if b.Class != "" && !isBlockClass(b.Class) {
		return schemaErr("%s: class %q — нужны строчные латинские буквы, цифры и дефис, до %d символов, начиная с буквы",
			at, b.Class, MaxBlockClassLen)
	}

	if n := utf8.RuneCountInString(b.Settings.Placeholder); n > MaxPlaceholderLen {
		return schemaErr("%s: placeholder длиннее %d символов", at, MaxPlaceholderLen)
	}
	if n := utf8.RuneCountInString(b.Settings.ImageKey); n > MaxImageKeyLen {
		return schemaErr("%s: imageKey длиннее %d символов", at, MaxImageKeyLen)
	}
	// imageKey — только у image (как options у choice).
	if b.Type != BlockImage && b.Settings.ImageKey != "" {
		return schemaErr("%s: тип %q не имеет картинки", at, b.Type)
	}
	// column — номер 1..MaxColumns у любого типа, кроме заголовка формы (canShareRow).
	// Секция — свойство РАСКЛАДКИ, а не типа: где именно окажется элемент, решает
	// раскладчик (автомат по потоку, §11.3 спеки), и поблочная проверка его условий
	// не видит — как не видит и кросс-блочного «секция открыта», которое здесь
	// намеренно не проверяется (см. Column в BlockSettings).
	if b.Settings.Column != 0 {
		if b.Settings.Column < 0 || b.Settings.Column > MaxColumns {
			return schemaErr("%s: колонка %d вне диапазона 1..%d", at, b.Settings.Column, MaxColumns)
		}
		if !b.Type.canShareRow() {
			return schemaErr("%s: тип %q не может делить ряд", at, b.Type)
		}
	}
	if err := validateScaleSettings(b); err != nil {
		return schemaErr("%s: %s", at, err)
	}
	// Условная логика (фаза 21): проверяется ФОРМА правил, а не их разрешимость —
	// ссылки, позиции и совместимость операторов кросс-блочны и потому инертны, а не
	// невалидны (logic.go, доклок).
	if err := validateLogic(b); err != nil {
		return schemaErr("%s: %s", at, err)
	}

	if !b.Type.isChoice() {
		if len(b.Settings.Options) > 0 {
			return schemaErr("%s: тип %q не имеет опций", at, b.Type)
		}
		return nil
	}

	if len(b.Settings.Options) > MaxOptions {
		return schemaErr("%s: больше %d опций", at, MaxOptions)
	}
	seenOpt := make(map[string]struct{}, len(b.Settings.Options))
	for j, o := range b.Settings.Options {
		if err := validateID(o.ID); err != nil {
			return schemaErr("%s: опция #%d: id: %s", at, j, err)
		}
		if _, dup := seenOpt[o.ID]; dup {
			return schemaErr("%s: повторяющийся id опции %q", at, o.ID)
		}
		seenOpt[o.ID] = struct{}{}
		if n := utf8.RuneCountInString(o.Label); n > MaxOptionLabelLen {
			return schemaErr("%s: опция #%d: label длиннее %d символов", at, j, MaxOptionLabelLen)
		}
		// Тот же номер колонки, что у блока (спека §5.1): тот же диапазон и тот же
		// раскладчик. Открыта ли секция — не проверяется, как и у блока: флаг инертен.
		if o.Column != 0 && (o.Column < 0 || o.Column > MaxColumns) {
			return schemaErr("%s: опция #%d: колонка %d вне диапазона 1..%d", at, j, o.Column, MaxColumns)
		}
		if err := validateCondition(o.VisibleIf, fmt.Sprintf("опция #%d: visibleIf", j)); err != nil {
			return schemaErr("%s: %s", at, err)
		}
	}
	return nil
}

// validateScaleSettings — диапазон шкалы: только у типа scale (как options у choice),
// оба конца заданы или ни одного (nil/nil — недособранный черновик, редактор его
// не создаёт), min < max и оба в [ScaleLowerBound, ScaleUpperBound].
func validateScaleSettings(b Block) error {
	min, max := b.Settings.ScaleMin, b.Settings.ScaleMax

	if b.Type != BlockScale {
		if min != nil || max != nil {
			return fmt.Errorf("тип %q не имеет шкалы", b.Type)
		}
		return nil
	}
	if min == nil && max == nil {
		return nil // черновик без диапазона — как choice без опций
	}
	if min == nil || max == nil {
		return fmt.Errorf("шкала: нужны оба конца диапазона")
	}
	if *min < ScaleLowerBound || *max > ScaleUpperBound {
		return fmt.Errorf("шкала: диапазон вне [%d, %d]", ScaleLowerBound, ScaleUpperBound)
	}
	if *min >= *max {
		return fmt.Errorf("шкала: минимум не меньше максимума")
	}
	return nil
}

// validateID проверяет стабильный идентификатор блока, группы или опции: непустой,
// корректный UTF-8, в пределах длины. Формат (префиксы blk_/grp_/opt_) не
// навязываем — id генерируется клиентом, серверу важны лишь непустота и длина.
func validateID(id string) error {
	switch {
	case id == "":
		return fmt.Errorf("пустой")
	case len(id) > MaxIDLen:
		return fmt.Errorf("длиннее %d байт", MaxIDLen)
	case !utf8.ValidString(id):
		return fmt.Errorf("не UTF-8")
	default:
		return nil
	}
}

// isHTTPURL — единственное правило redirect-ссылки: абсолютный http(s)-URL с
// хостом. Зеркалит isHttpUrl в web/shared/entities/formSchema.ts. Значение уходит
// в window.location рендерера, поэтому чужая схема (`javascript:`, `data:`) — это
// XSS на публичном домене формы (инвариант 4); относительный путь бессмыслен.
// Сервер — последняя инстанция: в опубликованную версию попадает только то, что
// прошло здесь.
func isHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// schemaErr оборачивает нарушение схемы в ErrValidation (единый маппинг на 422).
func schemaErr(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrValidation}, args...)...)
}
