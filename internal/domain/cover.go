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
// поле указатель.
//
// Y ДРОБНОЕ: процент хода стоит 3–6 px на обычной обложке и больше десяти на высоком
// снимке, и округление до целого сдвигало картинку после сохранения (решение владельца
// 2026-09-14). Кабинет пишет его с точностью до сотых.
const (
	CoverYMin     = 0
	CoverYMax     = 100
	DefaultCoverY = 50
)

// Геометрия хрома: высота обложки в процентах высоты ОКНА и размер логотипа в px.
// Зеркалят COVER_HEIGHT_*/LOGO_* в web/shared/entities/blocks/limits.ts.
//
// Дефолтов здесь нет намеренно: отсутствие ключа рисует fields.css своими
// значениями (--rf-cover-h, --rf-logo-w/-h/-radius), и Go про них ничего не знает —
// в отличие от CoverY, который подставляет сервер при печати object-position.
const (
	// Низ 5% — тоньше полоса перестаёт читаться как обложка; верх 75% — выше
	// заголовок формы уезжает за пределы первого экрана.
	CoverHeightMin = 5
	CoverHeightMax = 75
	// Потолок размера — 240px: логотип шире трети колонки перестаёт быть знаком
	// страницы. Потолок радиуса — половина потолка размера, дальше браузер зажимает
	// скругление сам.
	LogoSizeMin   = 24
	LogoSizeMax   = 240
	LogoRadiusMin = 0
	LogoRadiusMax = 120
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
	Y *float64 `json:"y,omitempty"`
	// Height — высота полосы в процентах высоты окна. Осмысленна и у цвета, и у
	// картинки — в отличие от Y, поэтому пары «только вместе с ImageKey» здесь нет.
	Height *int `json:"height,omitempty"`
}

// FormLogo — логотип страницы формы: картинка плюс её геометрия. Размер и
// скругление — указатели по той же причине, что FontSize у оформления: «не задано»
// (рисуй дефолтом fields.css) и «задан 0» обязаны быть разными состояниями.
type FormLogo struct {
	ImageKey string `json:"imageKey"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
	Radius   *int   `json:"radius,omitempty"`
}

// CoverY возвращает точку фокуса обложки с подставленным дефолтом. Единая точка
// подстановки: рендерер и превью не должны каждый знать, что «нет ключа» = центр.
func (c *FormCover) CoverY() float64 {
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
	if c.Height != nil && (*c.Height < CoverHeightMin || *c.Height > CoverHeightMax) {
		return fmt.Errorf("cover: height вне диапазона %d–%d", CoverHeightMin, CoverHeightMax)
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
	for _, f := range []struct {
		name string
		v    *int
		lo   int
		hi   int
	}{
		{"width", l.Width, LogoSizeMin, LogoSizeMax},
		{"height", l.Height, LogoSizeMin, LogoSizeMax},
		{"radius", l.Radius, LogoRadiusMin, LogoRadiusMax},
	} {
		if f.v != nil && (*f.v < f.lo || *f.v > f.hi) {
			return fmt.Errorf("logo: %s вне диапазона %d–%d", f.name, f.lo, f.hi)
		}
	}
	return nil
}
