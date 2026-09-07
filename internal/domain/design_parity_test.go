package domain

import (
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// Паритет оформления (фаза 22): состав CSS-переменных, списки перечислимых настроек
// и числа границ совпадают с фронтом. Тест ЧИТАЕТ TypeScript по тому же доводу, что
// logicparity_test.go: копия таблицы, живущая рядом с проверяемым кодом,
// разъезжается вместе с ним.
//
// Почему именно эти три вещи машинно.
//
// СОСТАВ ПЕРЕМЕННЫХ. Расхождение здесь даёт самый неприятный вид дефекта: Go
// печатает критические переменные в <head> публичной страницы, клиент следом
// надевает свой набор — и если наборы разошлись, форма МИГАЕТ одним видом и
// устаканивается в другом. Дефект живёт доли секунды, воспроизводится только на
// медленной сети и в тестах не виден вовсе.
//
// СПИСКИ ЗНАЧЕНИЙ. Значение, разрешённое на фронте и забытое на бэке, — это 422
// посреди автосейва на настройке, которую панель сама и предложила. Обратное
// расхождение тише и хуже: сервер принимает то, чего интерфейс не умеет показать.
//
// ЧИСЛА ГРАНИЦ. Разошедшийся диапазон — та же пара симптомов: либо панель даёт
// выбрать кегль, который сервер отвергнет, либо наоборот.
//
// Семантика (что настройка ЗНАЧИТ) машинной сверке недоступна — её держат таблицы
// кейсов одинакового состава: design_test.go здесь и design.test.ts там.

const (
	designTSRel   = "../../web/shared/fields/design.ts"
	entitiesTSRel = "../../web/shared/entities/formSchema.ts"
	designGoRel   = "design_vars.go"
	fieldsCSSRel  = "../../web/shared/fields/fields.css"
	fontsDirRel   = "../../web/shared/fonts"
)

var (
	// Имена переменных берутся из таблицы SPECS: каждая строка начинается с ['--rf-…'.
	reTSVarName = regexp.MustCompile(`\['(--rf-[a-z-]+)'`)
	// (?s) — список может быть и многострочным: prettier ломает строку на printWidth 100,
	// и седьмое семейство в DESIGN_FONTS её перешагнуло. Без флага тест краснел бы не на
	// расхождении, а на переносе, и чинили бы его форматированием.
	reTSConstArr = regexp.MustCompile(`(?s)export const (DESIGN_[A-Z_]+) = \[(.*?)\] as const`)
	reTSQuoted   = regexp.MustCompile(`'([a-zA-Z_]+)'`)
	reTSNumConst = regexp.MustCompile(`export const (MIN_FONT_SIZE|MAX_FONT_SIZE|MIN_RADIUS|MAX_RADIUS|MIN_COLUMN|MAX_COLUMN|MIN_FIELD_WIDTH|MAX_FIELD_WIDTH|MIN_FIELD_HEIGHT|MAX_FIELD_HEIGHT|MIN_BORDER_WIDTH|MAX_BORDER_WIDTH|MIN_PADDING_X|MAX_PADDING_X|MIN_MARGIN_BOTTOM|MAX_MARGIN_BOTTOM|MIN_BUTTON_WIDTH|MAX_BUTTON_WIDTH|MIN_BUTTON_HEIGHT|MAX_BUTTON_HEIGHT|MIN_BUTTON_FONT|MAX_BUTTON_FONT|MIN_BUTTON_RADIUS|MAX_BUTTON_RADIUS|MIN_BUTTON_MARGIN_TOP|MAX_BUTTON_MARGIN_TOP|MIN_BUTTON_PADDING_X|MAX_BUTTON_PADDING_X|BUTTON_WIDTH_DEFAULT) = (\d+)`)
	reTSClass    = regexp.MustCompile(`push\('(rf-[a-z-]+)'\)`)
	reGoClass    = regexp.MustCompile(`append\(out, "(rf-[a-z-]+)"\)`)
	reLineCmt    = regexp.MustCompile(`(?m)//.*$`)
	reCSSCanvas  = regexp.MustCompile(`--rf-canvas:\s*([^;]+);`)
	reCSSFont    = regexp.MustCompile(`--rf-font-family:\s*([^;]+);`)
)

func readSharedTS(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("зеркало недоступно (%s): %v", path, err)
	}
	// Комментарии вырезаются: в них лежат примеры и объяснения, и без вычистки
	// разбор ловил бы имена переменных из прозы.
	return reLineCmt.ReplaceAllString(string(raw), "")
}

func TestDesignVarNamesParity(t *testing.T) {
	body := readSharedTS(t, designTSRel)

	var ts []string
	seen := map[string]bool{}
	for _, m := range reTSVarName.FindAllStringSubmatch(body, -1) {
		if seen[m[1]] {
			t.Fatalf("переменная %s разобрана дважды — разбор SPECS сломался", m[1])
		}
		seen[m[1]] = true
		ts = append(ts, m[1])
	}
	if len(ts) == 0 {
		t.Fatal("SPECS пуст — разбор fields/design.ts сломался")
	}

	var got []string
	for _, s := range designVarSpecs {
		got = append(got, s.name)
	}

	// Порядок тоже сверяется: он контрактный (по нему читаются обе таблицы), и
	// расхождение порядка — верный признак того, что переменную добавили не туда.
	if !slices.Equal(got, ts) {
		t.Fatalf("состав CSS-переменных разошёлся:\n  Go: %v\n  TS: %v", got, ts)
	}
}

// Классы контейнера сверяются отдельно от переменных: расхождение здесь тише и
// потому опаснее. Переменная, забытая на одной стороне, не красит элемент — это
// видно. Класс, забытый на одной стороне, означает, что сервер напечатал в <head>
// разметку одной формы, а клиент следом надел другую: контурная кнопка мигнёт
// заливкой, рамка — тенью. Список читается из designClasses по строковым литералам.
func TestDesignClassesParity(t *testing.T) {
	body := readSharedTS(t, designTSRel)

	// Берём только тело designClasses: литералы rf-* встречаются и в комментариях
	// (их вычистил readSharedTS), и в других функциях файла быть не должно, но
	// сузить область разбора дешевле, чем однажды это обнаружить.
	i := strings.Index(body, "export function designClasses")
	if i < 0 {
		t.Fatal("designClasses не найдена — разбор fields/design.ts сломался")
	}
	var ts []string
	for _, m := range reTSClass.FindAllStringSubmatch(body[i:], -1) {
		ts = append(ts, m[1])
	}
	if len(ts) == 0 {
		t.Fatal("классы не разобраны — разбор designClasses сломался")
	}

	// Go-сторона читается ИЗ ИСХОДНИКА, а не собирается вызовами на подобранных
	// документах. Первая редакция этого теста перечисляла четыре FormDesign вручную и
	// сторожила только одно направление: класс, добавленный в TS и забытый в Go,
	// краснел, а обратный — класс, который печатает сервер и не надевает клиент, —
	// проходил молча, потому что ни один из подобранных документов новую ветку не
	// задевал. Именно обратное направление и опаснее: форма мигает одним видом и
	// устаканивается в другом.
	got := goClassLiterals(t)

	if !slices.Equal(got, ts) {
		t.Fatalf("состав классов контейнера разошёлся:\n  Go: %v\n  TS: %v", got, ts)
	}
}

// goClassLiterals — классы, которые печатает DesignClasses, прочитанные из её
// собственного текста. Симметрично разбору TS: обе стороны читаются одинаково, и
// тест не зависит от того, догадался ли автор подобрать нужный документ.
func goClassLiterals(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(designGoRel)
	if err != nil {
		t.Fatalf("исходник недоступен (%s): %v", designGoRel, err)
	}
	body := reLineCmt.ReplaceAllString(string(raw), "")
	i := strings.Index(body, "func DesignClasses")
	if i < 0 {
		t.Fatal("DesignClasses не найдена — разбор design_vars.go сломался")
	}
	var out []string
	for _, m := range reGoClass.FindAllStringSubmatch(body[i:], -1) {
		out = append(out, m[1])
	}
	if len(out) == 0 {
		t.Fatal("классы не разобраны — разбор DesignClasses сломался")
	}
	return out
}

func TestDesignEnumsParity(t *testing.T) {
	body := readSharedTS(t, entitiesTSRel)

	tsLists := map[string][]string{}
	for _, m := range reTSConstArr.FindAllStringSubmatch(body, -1) {
		var vals []string
		for _, q := range reTSQuoted.FindAllStringSubmatch(m[2], -1) {
			vals = append(vals, q[1])
		}
		tsLists[m[1]] = vals
	}
	if len(tsLists) == 0 {
		t.Fatal("списки DESIGN_* не разобраны — разбор entities/formSchema.ts сломался")
	}

	// Пары «имя на фронте → список на бэке». Забытая пара краснеет проверкой полноты
	// ниже: иначе список, добавленный на фронт и не сверенный здесь, молча уехал бы
	// без пары на Go.
	pairs := map[string][]string{
		"DESIGN_THEMES":          designThemes,
		"DESIGN_DENSITIES":       designDensities,
		"DESIGN_ALIGNS":          designAligns,
		"DESIGN_OUTLINES":        designOutlines,
		"DESIGN_BUTTON_VARIANTS": designButtonVariant,
		"DESIGN_BUTTON_WIDTHS":   designButtonWidth,
		"DESIGN_BUTTON_ALIGNS":   designButtonAligns,
		"DESIGN_BUTTON_SIZES":    designButtonSize,
		"DESIGN_BUTTON_WEIGHTS":  designButtonWeights,
		"DESIGN_FONTS":           designFonts,
	}
	for name, goList := range pairs {
		tsList, ok := tsLists[name]
		if !ok {
			t.Errorf("список %s есть на Go, но не найден в TS", name)
			continue
		}
		if !slices.Equal(goList, tsList) {
			t.Errorf("%s разошёлся:\n  Go: %v\n  TS: %v", name, goList, tsList)
		}
	}
	for name := range tsLists {
		if _, ok := pairs[name]; !ok {
			t.Errorf("список %s есть в TS, но не сверяется с Go — добавь пару в этот тест", name)
		}
	}
}

func TestDesignLimitsParity(t *testing.T) {
	body := readSharedTS(t, entitiesTSRel)

	goLimits := map[string]int{
		"MIN_FONT_SIZE":         MinFontSize,
		"MAX_FONT_SIZE":         MaxFontSize,
		"MIN_RADIUS":            MinRadius,
		"MAX_RADIUS":            MaxRadius,
		"MIN_COLUMN":            MinColumn,
		"MAX_COLUMN":            MaxColumn,
		"MIN_FIELD_WIDTH":       MinFieldWidth,
		"MAX_FIELD_WIDTH":       MaxFieldWidth,
		"MIN_FIELD_HEIGHT":      MinFieldHeight,
		"MAX_FIELD_HEIGHT":      MaxFieldHeight,
		"MIN_BORDER_WIDTH":      MinBorderWidth,
		"MAX_BORDER_WIDTH":      MaxBorderWidth,
		"MIN_PADDING_X":         MinPaddingX,
		"MAX_PADDING_X":         MaxPaddingX,
		"MIN_MARGIN_BOTTOM":     MinMarginBottom,
		"MAX_MARGIN_BOTTOM":     MaxMarginBottom,
		"MIN_BUTTON_WIDTH":      MinButtonWidth,
		"MAX_BUTTON_WIDTH":      MaxButtonWidth,
		"BUTTON_WIDTH_DEFAULT":  ButtonWidthDefault,
		"MIN_BUTTON_HEIGHT":     MinButtonHeight,
		"MAX_BUTTON_HEIGHT":     MaxButtonHeight,
		"MIN_BUTTON_FONT":       MinButtonFont,
		"MAX_BUTTON_FONT":       MaxButtonFont,
		"MIN_BUTTON_RADIUS":     MinButtonRadius,
		"MAX_BUTTON_RADIUS":     MaxButtonRadius,
		"MIN_BUTTON_MARGIN_TOP": MinButtonMarginTop,
		"MAX_BUTTON_MARGIN_TOP": MaxButtonMarginTop,
		"MIN_BUTTON_PADDING_X":  MinButtonPaddingX,
		"MAX_BUTTON_PADDING_X":  MaxButtonPaddingX,
	}

	found := map[string]bool{}
	for _, m := range reTSNumConst.FindAllStringSubmatch(body, -1) {
		want, ok := goLimits[m[1]]
		if !ok {
			continue
		}
		got, err := strconv.Atoi(m[2])
		if err != nil {
			t.Fatalf("%s: не число %q", m[1], m[2])
		}
		if got != want {
			t.Errorf("%s разошлась: Go %d, TS %d", m[1], want, got)
		}
		found[m[1]] = true
	}
	for name := range goLimits {
		if !found[name] {
			t.Errorf("граница %s не найдена в TS — зеркало разошлось по составу", name)
		}
	}
}

// Тёмный холст — ЕДИНСТВЕННОЕ значение темы, продублированное в Go (designDarkCanvas):
// <meta name="theme-color"> принимает только литеральный цвет, var() там не работает.
// Всё прочее, что делает тёмная тема, приезжает классом на <html> и копии не требует.
// Разойдётся — строка браузера на публичной форме станет другого цвета, чем сама
// форма, и заметит это только глаз на телефоне.
func TestDesignDarkCanvasParity(t *testing.T) {
	raw, err := os.ReadFile(fieldsCSSRel)
	if err != nil {
		t.Fatalf("fields.css недоступен (%s): %v", fieldsCSSRel, err)
	}
	body := string(raw)
	i := strings.Index(body, ".rf-theme-dark {")
	if i < 0 {
		t.Fatal(".rf-theme-dark не найден — разбор fields.css сломался")
	}
	end := strings.Index(body[i:], "\n}")
	if end < 0 {
		t.Fatal("не найден конец правила .rf-theme-dark")
	}
	m := reCSSCanvas.FindStringSubmatch(body[i : i+end])
	if m == nil {
		t.Fatal("--rf-canvas не найден в .rf-theme-dark — разбор fields.css сломался")
	}
	if got := strings.TrimSpace(m[1]); got != designDarkCanvas {
		t.Fatalf("холст тёмной темы разошёлся:\n  Go:  %q\n  CSS: %q", designDarkCanvas, got)
	}
}

// Дефолтное семейство — второе значение, продублированное в Go (DesignFontDefault):
// по нему сервер ставит <link rel=preload>, а рисует форму :root fields.css. Разойдутся —
// preload приедет за файлом, который никому не нужен, а настоящий шрифт формы браузер
// начнёт качать только дойдя до @font-face: форма мигнёт системным начертанием ровно на
// тех формах, где автор ничего не настраивал, то есть на большинстве.
//
// Сравнивается СТЕК целиком, а не имя семейства: стек в CSS и стек в designFontStack —
// это одна строка в двух местах, и разъехаться она может любым концом.
func TestDesignDefaultFontParity(t *testing.T) {
	raw, err := os.ReadFile(fieldsCSSRel)
	if err != nil {
		t.Fatalf("fields.css недоступен (%s): %v", fieldsCSSRel, err)
	}
	body := string(raw)
	i := strings.Index(body, ":root {")
	if i < 0 {
		t.Fatal(":root не найден — разбор fields.css сломался")
	}
	m := reCSSFont.FindStringSubmatch(body[i:])
	if m == nil {
		t.Fatal("--rf-font-family не найден в :root — разбор fields.css сломался")
	}
	// В CSS объявление может быть переносным (значение с новой строки) — схлопываем
	// пробелы, иначе тест краснел бы от переформатирования.
	got := strings.Join(strings.Fields(m[1]), " ")
	want := designFontStack[DesignFontDefault]
	if got != want {
		t.Fatalf("дефолтный шрифт разошёлся:\n  Go  (%s): %q\n  CSS (:root): %q", DesignFontDefault, want, got)
	}
}

// Файлы подмножеств обязаны существовать на диске и покрывать каждое семейство
// каталога. Опечатка в базовом имени не ломает ни сборку, ни линт: она
// даёт <link rel=preload> на несуществующий файл — то есть лишний 404 и молча
// потерянный preload, ровно ту оптимизацию, ради которой всё и делалось.
func TestDesignFontFilesExist(t *testing.T) {
	for _, key := range designFonts {
		files := designFontFiles[key]
		if len(files) == 0 {
			t.Errorf("шрифт %q есть в каталоге, но файлов подмножеств у него нет", key)
			continue
		}
		for _, base := range files {
			path := fontsDirRel + "/" + base + ".woff2"
			if _, err := os.Stat(path); err != nil {
				t.Errorf("шрифт %q: файла %s нет на диске (%v)", key, path, err)
			}
		}
	}
	for key := range designFontFiles {
		if !slices.Contains(designFonts, key) {
			t.Errorf("файлы заданы для %q, которого нет в каталоге шрифтов", key)
		}
	}
}
