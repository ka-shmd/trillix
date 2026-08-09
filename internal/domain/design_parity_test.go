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
)

var (
	// Имена переменных берутся из таблицы SPECS: каждая строка начинается с ['--rf-…'.
	reTSVarName  = regexp.MustCompile(`\['(--rf-[a-z-]+)'`)
	reTSConstArr = regexp.MustCompile(`export const (DESIGN_[A-Z_]+) = \[(.*?)\] as const`)
	reTSQuoted   = regexp.MustCompile(`'([a-zA-Z_]+)'`)
	reTSNumConst = regexp.MustCompile(`export const (MIN_FONT_SIZE|MAX_FONT_SIZE|MIN_RADIUS|MAX_RADIUS|MIN_COLUMN|MAX_COLUMN) = (\d+)`)
	reTSClass    = regexp.MustCompile(`push\('(rf-[a-z-]+)'\)`)
	reGoClass    = regexp.MustCompile(`append\(out, "(rf-[a-z-]+)"\)`)
	reLineCmt    = regexp.MustCompile(`(?m)//.*$`)
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
		"DESIGN_BUTTON_SIZES":    designButtonSize,
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
		"MIN_FONT_SIZE": MinFontSize,
		"MAX_FONT_SIZE": MaxFontSize,
		"MIN_RADIUS":    MinRadius,
		"MAX_RADIUS":    MaxRadius,
		"MIN_COLUMN":    MinColumn,
		"MAX_COLUMN":    MaxColumn,
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
