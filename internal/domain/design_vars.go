package domain

import (
	"fmt"
	"sort"
	"strings"
)

// ПЕРЕВОД ОФОРМЛЕНИЯ В CSS-ПЕРЕМЕННЫЕ — близнец designToVars из
// web/shared/fields/design.ts. Две реализации одного отображения, как
// ValidateSchema ↔ Zod: общего пакета между Go и TS в проекте нет.
//
// Зачем он вообще нужен на Go, если тему надевает фронт. Рендерер — SPA: схема
// приезжает вторым запросом, и тёмная форма сначала мигнула бы белой — заметно на
// медленной сети и заметно именно на той форме, за которую заплатили. Точка вставки
// уже есть: Go собирает index.html публичной страницы вокруг <!--og-meta-->
// (internal/forms/public_page.go), туда же уходит <style> с критическими
// переменными из снапшота. Первый кадр — за сервером, полный набор надевает клиент.
//
// Расхождение двух реализаций — самый неприятный вид дефекта: он мигает и исчезает.
// Поэтому состав ключей сверяется машинно (design_vars_parity_test.go читает
// TypeScript), а значения — таблицами кейсов одинакового состава с обеих сторон.

// Множители ритма. Ритм полотна (14/28/48, этап 13.3) задан долями базы, поэтому
// плотность — один множитель на все три интервала, а не три числа.
var designDensityScale = map[string]string{"compact": "0.75", "normal": "1", "roomy": "1.25"}

// Стеки шрифтов. Системный — нулевого веса и потому дефолт; остальные подключаются
// самохостом (@font-face приезжает слайсом 4), здесь только имя семейства с тем же
// системным хвостом на случай, если файл не догрузился.
var designFontStack = map[string]string{
	"system": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
	"inter":  "Inter, system-ui, -apple-system, sans-serif",
	"golos":  "'Golos Text', system-ui, -apple-system, sans-serif",
}

// designVarSpec описывает одну переменную: как её зовут и как достать значение.
// Таблицей, а не цепочкой if: состав ключей — контракт с фронтом, и он должен
// читаться списком, а не собираться из двадцати ветвей.
type designVarSpec struct {
	name string
	get  func(d *FormDesign) string
}

// designVarSpecs — ПОЛНЫЙ состав переменных оформления. Порядок здесь не важен
// (результат сортируется), но список обязан совпадать с TS по составу — сторожит
// паритет-тест.
var designVarSpecs = []designVarSpec{
	{"--rf-canvas", func(d *FormDesign) string { return palette(d, func(p *DesignPalette) string { return p.Canvas }) }},
	{"--rf-field-bg", func(d *FormDesign) string { return palette(d, func(p *DesignPalette) string { return p.Field }) }},
	{"--rf-text", func(d *FormDesign) string { return palette(d, func(p *DesignPalette) string { return p.Text }) }},
	{"--rf-muted", func(d *FormDesign) string { return palette(d, func(p *DesignPalette) string { return p.Muted }) }},
	{"--rf-accent", func(d *FormDesign) string { return palette(d, func(p *DesignPalette) string { return p.Accent }) }},
	// Буквенный бейдж выбранного варианта — свой токен: у Tally он замерен чуть темнее
	// акцента (rgb(0,112,215) против rgb(0,122,255)), и это соотношение не выражается
	// ни одним множителем. Дефолт остаётся замеренным, но как только автор задал
	// акцент, бейдж обязан ехать за ним — иначе выбранный вариант получает синюю
	// метку посреди зелёной формы.
	{"--rf-accent-badge", func(d *FormDesign) string { return palette(d, func(p *DesignPalette) string { return p.Accent }) }},
	{"--rf-primary", func(d *FormDesign) string { return palette(d, func(p *DesignPalette) string { return p.Button }) }},
	{"--rf-primary-foreground", func(d *FormDesign) string {
		return palette(d, func(p *DesignPalette) string { return p.ButtonText })
	}},
	{"--rf-font-family", func(d *FormDesign) string { return designFontStack[d.Font] }},
	{"--rf-font-size", func(d *FormDesign) string {
		if d.Layout == nil || d.Layout.FontSize == nil {
			return ""
		}
		return fmt.Sprintf("%dpx", *d.Layout.FontSize)
	}},
	{"--rf-column", func(d *FormDesign) string {
		if d.Layout == nil || d.Layout.Width == nil {
			return ""
		}
		return fmt.Sprintf("%dpx", *d.Layout.Width)
	}},
	{"--rf-density", func(d *FormDesign) string {
		if d.Layout == nil {
			return ""
		}
		return designDensityScale[d.Layout.Density]
	}},
	{"--rf-align", func(d *FormDesign) string {
		if d.Layout == nil {
			return ""
		}
		return d.Layout.Align
	}},
	// Второй токен той же настройки, а не дубль: карточки вариантов стоят в
	// flex-колонке, где выравнивание делает align-items, и ключевого слова `left` он
	// не понимает вовсе. Один токен на оба свойства дал бы центрированный текст в
	// карточках, прижатых влево.
	{"--rf-align-items", func(d *FormDesign) string {
		if d.Layout == nil || d.Layout.Align != "center" {
			return ""
		}
		return "center"
	}},
	{"--rf-radius", func(d *FormDesign) string {
		if d.Controls == nil || d.Controls.Radius == nil {
			return ""
		}
		return fmt.Sprintf("%dpx", *d.Controls.Radius)
	}},
	// Кнопка. Положение — justify-content РЯДА (.rf-nav), а не align-self самой
	// кнопки: ряд горизонтальный, и align-self двигал бы её по вертикали, где двигать
	// нечего. При кнопке во всю ширину настройка инертна — свободного места не
	// остаётся; отдельной ветки для этого нет намеренно, инертное правило равно
	// отсутствующему.
	{"--rf-submit-justify", func(d *FormDesign) string {
		if d.Button == nil || d.Button.Align != "center" {
			return ""
		}
		return "center"
	}},
	{"--rf-submit-width", func(d *FormDesign) string {
		if d.Button == nil || d.Button.Width != "full" {
			return ""
		}
		return "100%"
	}},
	{"--rf-submit-h", func(d *FormDesign) string { return buttonSize(d).h }},
	{"--rf-submit-px", func(d *FormDesign) string { return buttonSize(d).px }},
	{"--rf-submit-ratio", func(d *FormDesign) string { return buttonSize(d).ratio }},
}

// Размеры кнопки. `md` тут нет намеренно: это дефолт fields.css, и печатать для него
// переменные значило бы писать в документ то, что и так есть.
type buttonMetrics struct{ h, px, ratio string }

var buttonSizes = map[string]buttonMetrics{
	"sm": {h: "2rem", px: "1rem", ratio: "0.75"},
	"lg": {h: "2.75rem", px: "2rem", ratio: "1"},
}

func buttonSize(d *FormDesign) buttonMetrics {
	if d.Button == nil {
		return buttonMetrics{}
	}
	return buttonSizes[d.Button.Size]
}

func palette(d *FormDesign, pick func(*DesignPalette) string) string {
	if d.Palette == nil {
		return ""
	}
	return pick(d.Palette)
}

// designDarkCanvas — холст тёмной темы, ЗЕРКАЛО `.rf-theme-dark { --rf-canvas }` из
// fields.css. Единственное значение темы, которое Go обязан знать наизусть, а не
// сослаться на переменную: <meta name="theme-color"> принимает только литеральный
// цвет — `var(--rf-canvas)` там не работает. Всё остальное, что делает тёмная тема,
// приезжает КЛАССОМ на <html> (DesignClasses), поэтому копии в Go не требует.
// Расхождение с CSS сторожит паритет-тест (design_parity_test.go).
const designDarkCanvas = "oklch(0.19 0.006 60)"

// DesignThemeColor — цвет строки браузера (<meta name="theme-color">) для публичной
// страницы: холст формы, разрешённый до литерала. Пусто значит «мету не печатать» —
// светлый холст по умолчанию и так белый, а лишняя мета фиксировала бы дефолт,
// который потом не переопределить темой ОС.
//
// Нотация уезжает в мету ровно та же, что в CSS (oklch у тёмной темы): браузер, её
// не понимающий, мету игнорирует — это ровно то же, что её отсутствие, и потому
// безопаснее подогнанного вручную hex-двойника, который разъедется с fields.css.
func DesignThemeColor(d *FormDesign) string {
	if d == nil {
		return ""
	}
	if c := palette(d, func(p *DesignPalette) string { return p.Canvas }); c != "" {
		return c
	}
	if d.Theme == "dark" {
		return designDarkCanvas
	}
	return ""
}

// designFontFiles — файлы подмножеств для каждого несистемного семейства (базовые
// имена в web/shared/fonts, без хеша сборки). Порядок значим: кириллица первой —
// на русской форме она нужна раньше латиницы.
//
// Оба подмножества, а не одно: латиница (U+0000-00FF) — это ещё и цифры, пробел и
// пунктуация, поэтому её скачает даже форма, в которой нет ни одной латинской буквы.
// Сторож соответствия каталогу — design_fonts_test.go.
var designFontFiles = map[string][]string{
	"inter": {"inter-cyrillic", "inter-latin"},
	"golos": {"golos-cyrillic", "golos-latin"},
}

// DesignFontFiles — базовые имена woff2 выбранного семейства для <link rel=preload>
// на публичной странице. Системный стек и незаданный шрифт дают пустой срез: качать
// нечего.
//
// Зачем preload вообще: шрифт объявлен в CSS, а браузер тянет файл, только когда
// увидит текст, которому тот назначен, — то есть уже после того, как загрузился
// бандл и вторым запросом приехала схема. Знать шрифт формы до этого может ровно
// один участник — сервер, у которого снапшот уже в руках.
func DesignFontFiles(d *FormDesign) []string {
	if d == nil {
		return nil
	}
	return designFontFiles[d.Font]
}

// DesignVars возвращает CSS-переменные оформления. ПУСТАЯ КАРТА для nil и для
// design без единого заданного поля — это не оптимизация, а контракт фазы: форма,
// у которой оформление не трогали, обязана рендериться байт в байт как до неё, и
// проще всего это гарантировать, не печатая ни одного объявления.
//
// Тема (light/dark) переменной здесь не даёт: она задаёт color-scheme и НАБОР
// ДЕФОЛТОВ, то есть выражается классом на контейнере, а не значением. Что именно
// она меняет — DesignThemeClass.
func DesignVars(d *FormDesign) map[string]string {
	if d == nil {
		return map[string]string{}
	}
	vars := make(map[string]string, len(designVarSpecs))
	for _, s := range designVarSpecs {
		if v := s.get(d); v != "" {
			vars[s.name] = v
		}
	}
	return vars
}

// DesignStyleAttr собирает переменные в строку для атрибута style — в том виде, в
// каком их печатает и фронт. Ключи СОРТИРУЮТСЯ: обход map в Go рандомизирован, а
// строка уезжает в HTML публичной страницы, и прыгающий порядок ломал бы и сравнение
// с фронтом, и любое кеширование ответа.
//
// Экранирования не делает и не должно: в значениях по построению только #rrggbb,
// целые числа с px и стеки шрифтов из закрытого списка — всё это прошло валидатор.
// Появится значение из свободного ввода автора — экранирование появляется вместе с
// ним, а не «на всякий случай» здесь.
func DesignStyleAttr(d *FormDesign) string {
	vars := DesignVars(d)
	names := make([]string, 0, len(vars))
	for n := range vars {
		names = append(names, n)
	}
	sort.Strings(names)

	var b strings.Builder
	for _, n := range names {
		b.WriteString(n)
		b.WriteString(": ")
		b.WriteString(vars[n])
		b.WriteString("; ")
	}
	return strings.TrimSpace(b.String())
}

// DesignClasses — классы контейнера формы; близнец designClasses из
// web/shared/fields/design.ts.
//
// КЛАССОМ, А НЕ ПЕРЕМЕННОЙ, выражается ровно то, что является другим СПОСОБОМ
// РИСОВАНИЯ, а не другим значением:
//   - тема — color-scheme переменной не выразить, а без него тёмная форма получает
//     светлый скроллбар и белое автозаполнение поверх; и на тёмном холсте слоёная
//     тень не видна вовсе, поэтому кольцо с тенями переопределяются с палитрой;
//   - контур — «рамка» и «без контура» зависят от темы (светлому холсту нужно тёмное
//     кольцо, тёмному светлое), и значением, не зная темы, это не выразить;
//   - контурная кнопка — тот же довод.
//
// Всё остальное (цвета, числа, ширины) — переменные: их можно назвать значением.
func DesignClasses(d *FormDesign) string {
	if d == nil {
		return ""
	}
	var out []string
	if d.Theme == "dark" {
		out = append(out, "rf-theme-dark")
	}
	if d.Controls != nil {
		switch d.Controls.Outline {
		case "border":
			out = append(out, "rf-outline-border")
		case "none":
			out = append(out, "rf-outline-none")
		}
	}
	if d.Button != nil && d.Button.Variant == "outline" {
		out = append(out, "rf-btn-outline")
	}
	return strings.Join(out, " ")
}
