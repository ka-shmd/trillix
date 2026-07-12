package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
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
)

// BlockType — тип блока формы. Семь отвечаемых полей MVP (ARCHITECTURE 3.4) плюс
// неотвечаемый «text» — статический абзац на полотне (заголовок/пояснение). text
// не собирает ответ: исключён из ValidateAnswers и CSV.
type BlockType string

const (
	BlockShortText    BlockType = "short_text"
	BlockLongText     BlockType = "long_text"
	BlockEmail        BlockType = "email"
	BlockNumber       BlockType = "number"
	BlockSingleChoice BlockType = "single_choice"
	BlockMultiChoice  BlockType = "multi_choice"
	BlockDate         BlockType = "date"
	BlockText         BlockType = "text"
)

func (t BlockType) valid() bool {
	switch t {
	case BlockShortText, BlockLongText, BlockEmail, BlockNumber,
		BlockSingleChoice, BlockMultiChoice, BlockDate, BlockText:
		return true
	default:
		return false
	}
}

// isChoice — у choice-типов настройки несут список опций; у остальных settings пуст.
func (t BlockType) isChoice() bool {
	return t == BlockSingleChoice || t == BlockMultiChoice
}

// isContent — неотвечаемый блок (пока только text): статический контент на
// полотне, не собирает ответ. Исключается из валидации ответов и выгрузки.
func (t BlockType) isContent() bool {
	return t == BlockText
}

// Option — вариант выбора у choice-блока. id стабилен и генерируется на клиенте
// один раз: ответы ссылаются на него, поэтому переименование label связь не рвёт.
type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// BlockSettings — типоспецифичные настройки блока. Пока единственное поле —
// options у choice-типов; у остальных типов объект пуст.
type BlockSettings struct {
	Options []Option `json:"options,omitempty"`
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

// FormSchema — документ черновика формы: версия формата и упорядоченный список блоков.
type FormSchema struct {
	SchemaVersion int     `json:"schemaVersion"`
	Blocks        []Block `json:"blocks"`
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

// schemaErr оборачивает нарушение схемы в ErrValidation (единый маппинг на 422).
func schemaErr(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrValidation}, args...)...)
}
