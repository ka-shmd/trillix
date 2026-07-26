package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
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

// SchemaVersion — текущая версия формата. Старые документы апгрейдятся на чтении
// цепочкой v1→v2→v3 (ValidateSchema) без миграции БД.
const SchemaVersion = 3

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
	MaxSpans          = 200
	MaxOptionLabelLen = 500
	MaxIDLen          = 64
	MaxSubmitLabelLen = 100
	MaxPlaceholderLen = 200
	MaxImageKeyLen    = 200
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
)

// ColumnRight — единственное значение бита ряда (спека §5): «встань в ряд с
// предыдущим». Отсутствие ключа = свой ряд; "left" канон не пишет и не принимает.
// Зеркалит COLUMN_RIGHT в formSchema.ts.
const ColumnRight = "right"

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
)

func (t BlockType) valid() bool {
	switch t {
	case BlockShortText, BlockLongText, BlockEmail, BlockPhone, BlockNumber, BlockScale,
		BlockSingleChoice, BlockDropdown, BlockMultiChoice, BlockDate, BlockConsent,
		BlockTitle, BlockLabel, BlockHeading, BlockText, BlockImage:
		return true
	default:
		return false
	}
}

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

// isCaption — блок-подпись группы (title/label): его text — подпись вопроса, из
// которой аналитика берёт имя колонки/шага. Крупная (title) против мелкой (label)
// — только вид, семантика одна.
func (t BlockType) isCaption() bool {
	return t == BlockTitle || t == BlockLabel
}

// isContent — неотвечаемый блок: подписи (title/label) и контент (heading/text/
// image). Не собирает ответ: исключён из ValidateAnswers, CSV и модели вопросов.
func (t BlockType) isContent() bool {
	return t == BlockTitle || t == BlockLabel || t == BlockHeading || t == BlockText || t == BlockImage
}

// isAnswerable — блок собирает ответ (все отвечаемые типы, включая consent).
func (t BlockType) isAnswerable() bool { return !t.isContent() }

// carriesText — тип несёт собственное поле text: подписи, контентные абзацы/
// заголовки и consent (текст согласия рядом с галочкой). У прочих отвечаемых
// (и у image) поле text обязано быть пустым.
func (t BlockType) carriesText() bool {
	return t == BlockTitle || t == BlockLabel || t == BlockHeading || t == BlockText || t == BlockConsent
}

// canShareRow — типу разрешено делить ряд с предыдущим вопросом (спека фазы 13 §5,
// ADR §10): визуально короткие контролы. long_text/scale/choice-карточки в половину
// колонки не читаются. Зеркалит canShareRow в formSchema.ts.
func (t BlockType) canShareRow() bool {
	switch t {
	case BlockShortText, BlockEmail, BlockPhone, BlockNumber, BlockDate, BlockDropdown:
		return true
	default:
		return false
	}
}

// Option — вариант выбора у choice-блока. id стабилен и генерируется на клиенте
// один раз: ответы ссылаются на него, поэтому переименование label связь не рвёт.
type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Column — тот же бит ряда, что у блока (спека §5.1): "right" = «встань в ряд
	// с предыдущим вариантом», пусто = свой ряд. У опций dropdown инертен (список
	// живёт в нативном select) — и потому не запрещён, как и любой другой флаг,
	// которому некуда примениться.
	Column string `json:"column,omitempty"`
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
	// Column — ряд из двух вопросов (спека §5): "right" на отвечаемом блоке
	// читается как «встань в ряд с предыдущим вопросом», пусто = свой ряд.
	// Ширина не хранится вовсе — её выводит раскладчик. Только у canShareRow-типов.
	//
	// Кросс-блочное условие «левый сосед существует и умеет делить ряд» здесь
	// НЕ проверяется намеренно: флаг, которому некуда примениться, инертен и
	// легален, иначе undo и промежуточные состояния драга ловили бы 422.
	Column string `json:"column,omitempty"`
}

// Block — один блок формы. GroupID связывает блоки одного вопроса (ARCHITECTURE
// 3.4): вопрос — группа блоков подряд с общим groupId, в которой не более одного
// отвечаемого блока. Text несут только carriesText-типы; у отвечаемых полей
// (кроме consent) он пуст — подпись живёт в блоке title/label той же группы.
//
// Text — богатый текст (v3): плоский массив спанов, см. spans.go. Плоскую строку для
// данных даёт PlainText.
type Block struct {
	ID       string        `json:"id"`
	GroupID  string        `json:"groupId"`
	Type     BlockType     `json:"type"`
	Text     []Span        `json:"text,omitempty"`
	Required bool          `json:"required,omitempty"`
	Settings BlockSettings `json:"settings"`
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
}

// ValidateSchema строго разбирает и проверяет JSONB-документ схемы формы. v1-
// документы (по schemaVersion 0/1) сперва апгрейдятся до v2 (upgradeV1toV2) —
// читатель приводит формат на лету, БД не мигрируется (ARCHITECTURE 3.4).
//
// Лишние поля запрещены (DisallowUnknownFields) — расхождение контракта ловится
// сразу, а не оседает мусором в JSONB. Все нарушения возвращаются как
// ErrValidation (→ 422 в respond.go), чистая функция без HTTP и SQL.
//
// Это валидатор *черновика* билдера: пустой текст подписи и choice без опций
// допустимы — это нормальное недособранное состояние, которое автосейв обязан
// уметь хранить. Требование «непустая подпись, ≥1 опция» — правило момента
// публикации (фаза 4), не хранения.
func ValidateSchema(raw json.RawMessage) (FormSchema, error) {
	// Пик версии без строгого разбора: у v1-документа поля label/description,
	// которых нет в v2-структуре, и строгий декодер упал бы до апгрейда.
	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return FormSchema{}, schemaErr("не удалось разобрать схему: %v", err)
	}
	// Апгрейд ЦЕПОЧКОЙ, а не отдельным конвертером на каждую пару версий: v1
	// поднимается до v2, v2 — до v3, и добавление v4 будет означать одну новую
	// функцию и одну строку здесь, а не N² переходов.
	switch probe.SchemaVersion {
	case SchemaVersion:
		// уже v3
	case 0, 1, 2:
		if probe.SchemaVersion < 2 {
			// v1 (или дефолт БД '{"blocks":[]}' без версии).
			upgraded, err := upgradeV1toV2(raw)
			if err != nil {
				return FormSchema{}, err
			}
			raw = upgraded
		}
		upgraded, err := upgradeV2toV3(raw)
		if err != nil {
			return FormSchema{}, err
		}
		raw = upgraded
	default:
		return FormSchema{}, schemaErr("неизвестная schemaVersion %d", probe.SchemaVersion)
	}

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()

	var s FormSchema
	if err := dec.Decode(&s); err != nil {
		return FormSchema{}, schemaErr("не удалось разобрать схему: %v", err)
	}
	if dec.More() {
		return FormSchema{}, schemaErr("лишние данные после схемы")
	}

	// После апгрейда schemaVersion всегда 3; отсутствие трактуем как текущую
	// (апгрейд её проставляет, но пустой дефолт мог прийти уже канонический).
	if s.SchemaVersion == 0 {
		s.SchemaVersion = SchemaVersion
	}
	if s.SchemaVersion != SchemaVersion {
		return FormSchema{}, schemaErr("неизвестная schemaVersion %d", s.SchemaVersion)
	}

	if len(s.Blocks) > MaxBlocks {
		return FormSchema{}, schemaErr("больше %d блоков", MaxBlocks)
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

	if err := validateGroups(s.Blocks); err != nil {
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

// CanonicalV3 приводит сырую схему к каноническому v3-JSON: апгрейд цепочкой
// v1→v2→v3 и валидация. Нужна на отдаче фронту, который знает только текущий формат
// (рендерер читает опубликованную версию, кабинет — черновик, и обе в БД могут быть
// ещё v1/v2). Идемпотентна на уже-v3. Ошибка означает битую схему в БД — наружу как есть.
func CanonicalV3(raw json.RawMessage) (json.RawMessage, error) {
	s, err := ValidateSchema(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(s)
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
	// column — только "right" и только у whitelist-типов (спека §5). Канон хранит
	// отклонение: "left" в документе не пишется, а значит и не принимается.
	if b.Settings.Column != "" {
		if b.Settings.Column != ColumnRight {
			return schemaErr("%s: неизвестная колонка %q", at, b.Settings.Column)
		}
		if !b.Type.canShareRow() {
			return schemaErr("%s: тип %q не может делить ряд", at, b.Type)
		}
	}
	if err := validateScaleSettings(b); err != nil {
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
		// Тот же бит ряда, что у блока (спека §5.1): только "right". Есть ли слева
		// свободная ячейка — не проверяется, как и у блока: флаг инертен, не невалиден.
		if o.Column != "" && o.Column != ColumnRight {
			return schemaErr("%s: опция #%d: неизвестная колонка %q", at, j, o.Column)
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
