package domain

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// ОФОРМЛЕНИЕ ФОРМЫ (фаза 22) — тема, цвета, шрифт, лэйаут, вид контролов.
//
// Живёт в схеме, а не в колонках forms, по тому же доводу, что обложка с логотипом
// (cover.go) и экран «после отправки»: схема снапшотится при публикации, поэтому
// респондент видит оформление ТОЙ ВЕРСИИ, по которой отправил ответ, а правка цвета
// в черновике не перекрашивает уже опубликованную форму.
//
// Тот же довод отвечает и на вопрос «а если появится тема воркспейса»: и тогда
// снапшот обязан хранить РАЗРЕШЁННЫЕ значения, а не ссылку на тему, — иначе
// ребрендинг задним числом перекрасил бы формы, на которые уже отвечали. Тема
// воркспейса станет источником заполнения этих полей, а не местом хранения.
//
// КАЖДОЕ ПОЛЕ НЕОБЯЗАТЕЛЬНО, И ОТСУТСТВИЕ ЗНАЧИТ «ДЕФОЛТ» — не «пусто» и не
// «наследуй», а именно сегодняшнее зашитое значение fields.css. Из этого следует
// главное свойство фазы: форма без design обязана рендериться байт в байт как до
// неё. Поэтому же schemaVersion не поднимается: правило только расширяет множество
// принимаемых документов (тот же довод, что у page_break и полей логики).
//
// Зеркало Zod — designSchema в web/shared/entities/formSchema.ts (правится тем же
// PR, с тестами обеих сторон). Перевод в CSS-переменные — designVars ниже и её
// близнец designToVars в web/shared/fields/design.ts.

// Границы числовых настроек. Диапазон, а не зажим: значение вне него ОТВЕРГАЕТСЯ.
// Молча исправленное число доживает до первого читателя, который решит, что оно
// что-то значит, — тот же довод, по которому cover.y при цвете отвергается.
const (
	// Базовый кегль. Потолок 20, а не «сколько угодно»: line-height полотна остаётся
	// литеральным (числа обязаны совпадать с Tailwind-классами кластеров значков
	// редактора), поэтому слишком крупная база перестанет помещаться в свою строку.
	MinFontSize = 14
	MaxFontSize = 20
	// Скругление контролов. 0 — прямые углы, осмысленный выбор; потолок 24 при
	// высоте контрола 36px — дальше поле превращается в пилюлю и перестаёт быть полем.
	MinRadius = 0
	MaxRadius = 24
	// Ширина колонки — ЧИСЛО, а не три варианта (решение владельца 2026-08-09):
	// выбор из «узкой/обычной/широкой» покрывает три макета из бесконечности. Низ —
	// 400: уже колонка перестаёт вмещать поле ввода с подписью; верх — 1200: дальше
	// строка длиннее комфортной для чтения, и это уже не форма, а таблица.
	MinColumn = 400
	MaxColumn = 1200
)

// Допустимые значения перечислимых настроек. Списки, а не свободные строки: набор
// конечен, и опечатка обязана краснеть, а не доезжать до CSS.
var (
	designThemes        = []string{"light", "dark"}
	designDensities     = []string{"compact", "normal", "roomy"}
	designAligns        = []string{"left", "center"}
	designOutlines      = []string{"shadow", "border", "none"}
	designButtonVariant = []string{"solid", "outline"}
	designButtonWidth   = []string{"auto", "full"}
	designButtonSize    = []string{"sm", "md", "lg"}
	// Шрифты — курируемый список self-hosted семейств с кириллицей. Внешний CDN не
	// подключить физически (CSP font-src 'self' data:), и ослаблять её не будем:
	// подключённый шрифт — это запрос браузера респондента на чужой сервер, то есть
	// передача IP третьему лицу на публичной странице сбора персональных данных.
	// Состав списка согласуется до слайса 4 (спека §13); здесь пока системный стек
	// плюс те, чьи лицензия и кириллица уже проверены.
	designFonts = []string{"system", "inter", "golos", "manrope", "onest", "montserrat", "lora"}
)

// FormDesign — оформление страницы формы.
type FormDesign struct {
	Theme   string         `json:"theme,omitempty"`
	Palette *DesignPalette `json:"palette,omitempty"`
	// Font — ОДИН на всю форму (решение владельца 2026-08-09). Раздельные семейства
	// для текста и заголовков на форме из десяти строк читаются не как брендирование,
	// а как небрежность, и удваивают вес раздачи.
	Font     string          `json:"font,omitempty"`
	Layout   *DesignLayout   `json:"layout,omitempty"`
	Controls *DesignControls `json:"controls,omitempty"`
	Button   *DesignButton   `json:"button,omitempty"`
	// Бейджа «Сделано в Trillix» здесь НЕТ и быть не должно: намерение автора живёт
	// колонкой forms.branding (ADR §10, миграция 0038). Оформление — документ, бейдж
	// — свойство выдачи: он обязан сниматься и возвращаться без перепубликации.
	// CSS — свой CSS формы (фаза 22, слайс 7). Уезжает в <style> рендерера ПОСЛЕ
	// наших правил, поэтому автор перебивает вид, не трогая наш файл.
	//
	// Почему это вообще безопасно — считает не валидатор, а CSP (спека §10.1):
	// `script-src 'self'` не даёт исполнить JS, `img-src 'self' data: blob:` —
	// утечь через url(), `style-src 'self' 'unsafe-inline'` — подтянуть чужой файл
	// через @import. React вставляет строку ТЕКСТОВЫМ узлом, а не innerHTML
	// (инвариант 4), поэтому выйти из <style> в разметку нечем.
	//
	// Что остаётся и принимается как риск: спрятать кнопку, накрыть страницу
	// position: fixed, скрыть текст согласия. Первые два — самострел автора на своей
	// форме; третий — риск площадки, и он смягчается тремя мерами: верхний тариф,
	// потолок объёма (MaxCustomCSSLen) и правило-сторож после авторского CSS.
	CSS string `json:"css,omitempty"`
}

// DesignPalette — цвета. Каждый — строго #rrggbb в нижнем регистре, тем же
// isHexColor, что у цвета спана и у cover.color: свободный CSS в схему не пускаем
// никогда (ADR §10), значение уходит в style, и регулярка не оставляет места ни для
// url(...), ни для наследия expression.
//
// Canvas и Field — РАЗНЫЕ поля, хотя сегодня оба белые: пока это был один токен,
// «цветная страница с белыми карточками» была невыразима вовсе (слайс 1).
type DesignPalette struct {
	Canvas     string `json:"canvas,omitempty"`
	Field      string `json:"field,omitempty"`
	Text       string `json:"text,omitempty"`
	Muted      string `json:"muted,omitempty"`
	Accent     string `json:"accent,omitempty"`
	Button     string `json:"button,omitempty"`
	ButtonText string `json:"buttonText,omitempty"`
}

// DesignLayout — геометрия страницы.
type DesignLayout struct {
	// Width — ширина колонки в px. Указатель по той же причине, что FontSize.
	Width *int `json:"width,omitempty"`
	// FontSize — база шкалы кеглей в px. Указатель: «не задан» и «задан 14» обязаны
	// быть разными состояниями, иначе нулевое значение читалось бы как выбор автора.
	FontSize *int   `json:"fontSize,omitempty"`
	Density  string `json:"density,omitempty"`
	Align    string `json:"align,omitempty"`
}

// DesignControls — вид поля: скругление и то, чем нарисован контур.
type DesignControls struct {
	// Radius — указатель по той же причине, что FontSize: 0 это осмысленный выбор
	// (прямые углы), а не «не задано».
	Radius  *int   `json:"radius,omitempty"`
	Outline string `json:"outline,omitempty"`
}

// DesignButton — кнопка отправки. Текст кнопки живёт отдельно (FormSchema.SubmitLabel):
// его респондент читает и правит автор на месте, это не оформление.
type DesignButton struct {
	Variant string `json:"variant,omitempty"`
	Width   string `json:"width,omitempty"`
	Align   string `json:"align,omitempty"`
	Size    string `json:"size,omitempty"`
}

// validateDesign проверяет оформление черновика. Ошибки — обычные значения; в
// ErrValidation их заворачивает вызывающий (schemaErr в ValidateSchema).
//
// Пустой объект design допустим и означает «всё по умолчанию» — в отличие от
// обложки, где пустота отвергается. Разница не в прихоти: у обложки два способа
// сказать «её нет» были бы двумя представлениями одного состояния, а у оформления
// «все поля по умолчанию» и «поля нет» — одно и то же состояние с одним смыслом,
// и отвергать его значило бы ронять автосейв на форме, где автор сбросил тему.
func validateDesign(d *FormDesign) error {
	if d == nil {
		return nil
	}
	if err := oneOf("theme", d.Theme, designThemes); err != nil {
		return err
	}
	if p := d.Palette; p != nil {
		for _, c := range []struct {
			field, value string
		}{
			{"canvas", p.Canvas},
			{"field", p.Field},
			{"text", p.Text},
			{"muted", p.Muted},
			{"accent", p.Accent},
			{"button", p.Button},
			{"buttonText", p.ButtonText},
		} {
			if c.value != "" && !isHexColor(c.value) {
				return fmt.Errorf("design.palette.%s: %q — нужен #rrggbb в нижнем регистре", c.field, c.value)
			}
		}
	}
	if err := oneOf("font", d.Font, designFonts); err != nil {
		return err
	}
	if l := d.Layout; l != nil {
		if err := oneOf("layout.density", l.Density, designDensities); err != nil {
			return err
		}
		if err := oneOf("layout.align", l.Align, designAligns); err != nil {
			return err
		}
		if l.Width != nil && (*l.Width < MinColumn || *l.Width > MaxColumn) {
			return fmt.Errorf("design.layout.width: %d вне диапазона %d–%d", *l.Width, MinColumn, MaxColumn)
		}
		if l.FontSize != nil && (*l.FontSize < MinFontSize || *l.FontSize > MaxFontSize) {
			return fmt.Errorf("design.layout.fontSize: %d вне диапазона %d–%d", *l.FontSize, MinFontSize, MaxFontSize)
		}
	}
	if c := d.Controls; c != nil {
		if err := oneOf("controls.outline", c.Outline, designOutlines); err != nil {
			return err
		}
		if c.Radius != nil && (*c.Radius < MinRadius || *c.Radius > MaxRadius) {
			return fmt.Errorf("design.controls.radius: %d вне диапазона %d–%d", *c.Radius, MinRadius, MaxRadius)
		}
	}
	if b := d.Button; b != nil {
		if err := oneOf("button.variant", b.Variant, designButtonVariant); err != nil {
			return err
		}
		if err := oneOf("button.width", b.Width, designButtonWidth); err != nil {
			return err
		}
		if err := oneOf("button.align", b.Align, designAligns); err != nil {
			return err
		}
		if err := oneOf("button.size", b.Size, designButtonSize); err != nil {
			return err
		}
	}
	if n := utf8.RuneCountInString(d.CSS); n > MaxCustomCSSLen {
		return fmt.Errorf("design.css: длиннее %d символов", MaxCustomCSSLen)
	}
	// `</` ОТВЕРГАЕТСЯ, и это не дубль защиты React'а, а второй рубеж в другом
	// месте. React вставит строку текстовым узлом, но склейка в <style> — единственная
	// в проекте точка, где пользовательский текст соседствует с HTML-разметкой по
	// существу: любой будущий читатель (серверный рендер, экспорт формы, письмо с
	// её копией) собрал бы её конкатенацией и получил `</style><script>`. В настоящем
	// CSS `</` не встречается — запрет не отнимает у автора ничего.
	if strings.Contains(d.CSS, "</") {
		return fmt.Errorf("design.css: последовательность \"</\" не допускается")
	}
	return nil
}

// DesignPaidFeatures — что в оформлении относится к платному ключу
// form_design_custom, человеческими словами и в порядке панели. Пустой срез значит
// «эту форму можно публиковать на любом тарифе».
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
//   - тема: обе, светлая и тёмная, бесплатны намеренно (спека §9.1) — гейт ставится
//     на созданную ценность, а не на настройку;
//   - системный шрифт: это сегодняшний дефолт полотна, и брать за него деньги
//     значило бы продавать «оставить как было»;
//   - branding: у бейджа свой ключ и своя точка гейта — отдача, а не публикация.
//
// Список нужен телу 402: «своё оформление недоступно» без перечня заставляет автора
// гадать, что именно снять.
func DesignPaidFeatures(d *FormDesign) []string {
	if d == nil {
		return nil
	}
	var out []string
	add := func(cond bool, name string) {
		if cond {
			out = append(out, name)
		}
	}
	if p := d.Palette; p != nil {
		add(p.Canvas != "" || p.Field != "" || p.Text != "" || p.Muted != "" ||
			p.Accent != "" || p.Button != "" || p.ButtonText != "", "цвета")
	}
	// ЛЮБОЙ записанный шрифт — платная настройка, включая "system": дефолт хранится
	// отсутствием ключа, поэтому записанное значение всегда означает выбор автора.
	// Пока дефолтом был системный стек, исключение для него значило «не выбирал»;
	// с Inter по умолчанию (DesignFontDefault) оно раздавало бы бесплатному тарифу
	// переключатель «Inter ↔ системный».
	add(d.Font != "", "шрифт")
	if l := d.Layout; l != nil {
		add(l.Width != nil, "ширина колонки")
		add(l.FontSize != nil, "размер текста")
		add(l.Density != "", "плотность")
		add(l.Align != "", "выравнивание")
	}
	if c := d.Controls; c != nil {
		add(c.Radius != nil, "скругление")
		add(c.Outline != "", "вид контура")
	}
	if b := d.Button; b != nil {
		add(b.Variant != "" || b.Width != "" || b.Align != "" || b.Size != "", "кнопка")
	}
	return out
}

// oneOf — пустая строка означает «не задано» и проходит; заданное обязано быть из
// списка. Отдельная функция, а не повторённое условие в двенадцати местах: набор
// перечислимых настроек будет расти, и каждое повторение — место, где однажды
// забудут проверку.
func oneOf(field, value string, allowed []string) error {
	if value == "" || slices.Contains(allowed, value) {
		return nil
	}
	return fmt.Errorf("design.%s: %q — допустимы %v", field, value, allowed)
}

// reBlockClass — форма своего имени блока: строчная латиница, цифры и дефис, первым
// символом буква. Зеркалит BLOCK_CLASS_RE в formSchema.ts.
//
// Своё имя не пересекается с нашими rf-* по построению? НЕТ — `rf-input` этой форме
// удовлетворяет, и запрещать его мы не будем: автор вправе целиться в наш класс,
// коль скоро узкое подмножество объявлено публичным контрактом (спека §10.6).
// Запрет означал бы обещание, которого мы не даём, — что имена не пересекутся.
var reBlockClass = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

func isBlockClass(s string) bool { return reBlockClass.MatchString(s) }
