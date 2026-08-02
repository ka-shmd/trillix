package domain

import (
	"fmt"
	"unicode/utf8"
)

// Обложка и логотип — ХРОМ СТРАНИЦЫ, а не блоки полотна: они не участвуют в
// группах, не собирают ответ, не попадают в CSV и не имеют места в потоке блоков.
// Поэтому они поля документа (FormSchema), а не элементы списка Blocks.
//
// В схеме, а не в колонках forms, — по тому же доводу, что у экрана «после
// отправки»: схема снапшотится при публикации, поэтому респондент видит оформление
// той версии, по которой отправил ответ. Смена обложки в черновике не переписывает
// вид уже опубликованной формы.
//
// Зеркало Zod — coverSchema/logoSchema в web/shared/entities/formSchema.ts.

// Границы точки фокуса обложки по вертикали. Y — доля высоты КАРТИНКИ в процентах,
// уезжающая в CSS object-position: 0 — прижата верхом, 100 — низом. Отсутствие
// ключа означает центр (DefaultCoverY), и это не то же самое, что Y=0, — потому
// поле указатель, а не int.
const (
	CoverYMin     = 0
	CoverYMax     = 100
	DefaultCoverY = 50
)

// FormCover — обложка страницы формы: ЛИБО сплошной цвет, ЛИБО картинка, никогда
// оба и никогда ни одного. Пустая обложка невыразима намеренно: «обложки нет»
// выражается отсутствием всего объекта, и второго способа сказать то же самое быть
// не должно — иначе каждый читатель обязан знать оба.
type FormCover struct {
	// Color — сплошной цвет, строгий #rrggbb (тот же формат и тот же валидатор,
	// что у цвета спана: свободный CSS в схему не пускаем никогда, ADR §10).
	Color string `json:"color,omitempty"`
	// ImageKey — ключ объекта в бакете медиа, как у блока image.
	ImageKey string `json:"imageKey,omitempty"`
	// Y — точка фокуса по вертикали; осмысленна только у картинки (у цвета
	// двигать нечего) и потому при Color запрещена, а не игнорируется: молча
	// принятый бессмысленный ключ доживает до первого читателя, который решит,
	// что он что-то значит.
	Y *int `json:"y,omitempty"`
}

// FormLogo — логотип страницы формы. Отдельный тип с одним полем, а не голая
// строка в FormSchema: у логотипа ожидаются свои свойства (форма, размер), и
// растить их из строки означало бы менять форму документа второй раз.
type FormLogo struct {
	ImageKey string `json:"imageKey"`
}

// CoverY возвращает точку фокуса обложки с подставленным дефолтом. Единая точка
// подстановки: рендерер и превью не должны каждый знать, что «нет ключа» = центр.
func (c *FormCover) CoverY() int {
	if c == nil || c.Y == nil {
		return DefaultCoverY
	}
	return *c.Y
}

// validateCover проверяет обложку черновика. Ошибки — обычные значения; в
// ErrValidation их заворачивает вызывающий (schemaErr в ValidateSchema).
func validateCover(c *FormCover) error {
	if c == nil {
		return nil
	}
	hasColor, hasImage := c.Color != "", c.ImageKey != ""
	if hasColor == hasImage {
		return fmt.Errorf("cover: нужен ровно один из color и imageKey")
	}
	if hasColor && !isHexColor(c.Color) {
		return fmt.Errorf("cover: цвет %q — нужен #rrggbb в нижнем регистре", c.Color)
	}
	if n := utf8.RuneCountInString(c.ImageKey); n > MaxImageKeyLen {
		return fmt.Errorf("cover: imageKey длиннее %d символов", MaxImageKeyLen)
	}
	if c.Y != nil {
		if !hasImage {
			return fmt.Errorf("cover: y задаётся только вместе с картинкой")
		}
		if *c.Y < CoverYMin || *c.Y > CoverYMax {
			return fmt.Errorf("cover: y вне диапазона %d–%d", CoverYMin, CoverYMax)
		}
	}
	return nil
}

// validateLogo проверяет логотип черновика. Пустой ключ отвергается по тому же
// правилу, что и пустая обложка: «логотипа нет» — это отсутствие объекта.
func validateLogo(l *FormLogo) error {
	if l == nil {
		return nil
	}
	if l.ImageKey == "" {
		return fmt.Errorf("logo: пустой imageKey")
	}
	if n := utf8.RuneCountInString(l.ImageKey); n > MaxImageKeyLen {
		return fmt.Errorf("logo: imageKey длиннее %d символов", MaxImageKeyLen)
	}
	return nil
}
