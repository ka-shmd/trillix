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

// SchemaVersion — текущая версия формата. Поле schemaVersion позволит
// эволюционировать формат без миграций БД (читатель применит upgrade-функции).
const SchemaVersion = 1

// Лимиты схемы. Верхние границы — защита от раздутого документа; длины строк
// считаются в рунах. Заведомо просторны для нормальной анкеты, но конечны.
const (
	MaxBlocks         = 200
	MaxOptions        = 100
	MaxLabelLen       = 1000
	MaxDescriptionLen = 2000
	MaxOptionLabelLen = 500
	MaxIDLen          = 64
	MaxSubmitLabelLen = 100
	MaxPlaceholderLen = 200
	MaxImageKeyLen    = 200
	MaxAltLen         = 500
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

// BlockType — тип блока формы. Отвечаемые поля (ARCHITECTURE 3.4) плюс два
// неотвечаемых (контентных): «text» — статический абзац, «image» — картинка на
// полотне. Контентные не собирают ответ: исключены из ValidateAnswers и CSV.
type BlockType string

const (
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
	BlockText         BlockType = "text"
	BlockImage        BlockType = "image"
)

func (t BlockType) valid() bool {
	switch t {
	case BlockShortText, BlockLongText, BlockEmail, BlockPhone, BlockNumber, BlockScale,
		BlockSingleChoice, BlockDropdown, BlockMultiChoice, BlockDate, BlockText, BlockImage:
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

// isContent — неотвечаемый блок (text, image): статический контент на полотне, не
// собирает ответ. Исключается из валидации ответов и выгрузки.
func (t BlockType) isContent() bool {
	return t == BlockText || t == BlockImage
}

// Option — вариант выбора у choice-блока. id стабилен и генерируется на клиенте
// один раз: ответы ссылаются на него, поэтому переименование label связь не рвёт.
type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// BlockSettings — типоспецифичные настройки блока: options у choice-типов,
// placeholder у текстовых полей ввода, imageKey/alt у типа image, диапазон у scale.
//
// ScaleMin/ScaleMax — указатели, а не int: 0 — законный минимум шкалы (NPS 0–10),
// и с `omitempty` нулевое значение вылетало бы из JSON, а «не задано» было бы
// неотличимо от «задано 0». Оба nil — недособранный черновик (допустим, как choice
// без опций); задан ровно один — ошибка.
type BlockSettings struct {
	Options     []Option `json:"options,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	ImageKey    string   `json:"imageKey,omitempty"`
	Alt         string   `json:"alt,omitempty"`
	ScaleMin    *int     `json:"scaleMin,omitempty"`
	ScaleMax    *int     `json:"scaleMax,omitempty"`
}

// Block — один вопрос формы.
type Block struct {
	ID          string        `json:"id"`
	Type        BlockType     `json:"type"`
	Label       string        `json:"label"`
	Description string        `json:"description"`
	Required    bool          `json:"required"`
	Settings    BlockSettings `json:"settings"`
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

// ValidateSchema строго разбирает и проверяет JSONB-документ схемы формы.
// Лишние поля запрещены (DisallowUnknownFields) — расхождение контракта ловится
// сразу, а не оседает мусором в JSONB. Все нарушения возвращаются как
// ErrValidation (→ 422 в respond.go), чистая функция без HTTP и SQL.
//
// Это валидатор *черновика* билдера: пустой label и choice без опций допустимы —
// это нормальное недособранное состояние, которое автосейв обязан уметь хранить.
// Требование «непустой label, ≥1 опция» — правило момента публикации (фаза 4),
// не хранения.
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

	// Отсутствующая schemaVersion трактуется как текущая: дефолт БД
	// '{"blocks": []}' её не содержит (ARCHITECTURE 3.3).
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
	// label): билдер коммитит поле в стор только по blur, поэтому недопечатанный
	// URL до автосейва не доезжает и 422 посреди набора не бывает.
	if s.RedirectURL != "" && !isHTTPURL(s.RedirectURL) {
		return FormSchema{}, schemaErr("redirectUrl: нужен абсолютный http(s)-адрес")
	}

	seen := make(map[string]struct{}, len(s.Blocks))
	for i := range s.Blocks {
		if err := validateBlock(i, s.Blocks[i], seen); err != nil {
			return FormSchema{}, err
		}
	}
	return s, nil
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
	if n := utf8.RuneCountInString(b.Label); n > MaxLabelLen {
		return schemaErr("%s: label длиннее %d символов", at, MaxLabelLen)
	}
	if n := utf8.RuneCountInString(b.Description); n > MaxDescriptionLen {
		return schemaErr("%s: description длиннее %d символов", at, MaxDescriptionLen)
	}
	if n := utf8.RuneCountInString(b.Settings.Placeholder); n > MaxPlaceholderLen {
		return schemaErr("%s: placeholder длиннее %d символов", at, MaxPlaceholderLen)
	}
	if n := utf8.RuneCountInString(b.Settings.ImageKey); n > MaxImageKeyLen {
		return schemaErr("%s: imageKey длиннее %d символов", at, MaxImageKeyLen)
	}
	if n := utf8.RuneCountInString(b.Settings.Alt); n > MaxAltLen {
		return schemaErr("%s: alt длиннее %d символов", at, MaxAltLen)
	}
	// imageKey/alt — только у image (как options у choice).
	if b.Type != BlockImage && (b.Settings.ImageKey != "" || b.Settings.Alt != "") {
		return schemaErr("%s: тип %q не имеет картинки", at, b.Type)
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

// validateID проверяет стабильный идентификатор блока или опции: непустой,
// корректный UTF-8, в пределах длины. Формат (префиксы blk_/opt_) не навязываем —
// id генерируется клиентом, серверу важны лишь непустота и уникальность.
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
