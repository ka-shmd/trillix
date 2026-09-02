package domain

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Паритет реестра типов блоков (фаза 16): свойства, объявленные в файлах типов на
// фронте, совпадают с предикатами Go.
//
// Зачем машинная сверка. Контракт схемы двусторонний, и до фазы 16 обе стороны
// перечисляли типы наборами: семь Set'ов в formSchema.ts против семи предикатов здесь.
// Расхождение не падало — оно молча трактовало тип как соседний (dropdown, забытый в
// isSingleChoice, начинал ждать массив вместо строки). Фаза убрала наборы на фронте,
// выведя предикаты из файлов типов; Go остался предикатным осознанно (ADR §10: он не
// может импортировать реестр, а 16 файлов в domain не дали бы ни одной новой гарантии).
// Значит, сверка сторон осталась ручной — этот тест её механизирует.
//
// Тест ЧИТАЕТ TypeScript, а не сравнивает две копии Go-таблицы: копия, живущая рядом с
// проверяемым кодом, разъезжается вместе с ним и ничего не ловит. Разбор намеренно
// буквальный (файлы типов — литералы фиксированной формы); сменилась форма файла — тест
// падает с внятным «не удалось прочитать», и парсер правится вместе с формой. Это лучше
// молчаливого пропуска: тест, который перестал что-то проверять, хуже отсутствующего.
//
// Что тест НЕ покрывает и почему: requiresCaption (правило вставки редактора, зеркала в
// Go нет намеренно) и ownSettings (в Go проверки закреплённых ключей написаны в validateBlock поштучно, и
// сверять их следует поведением — это делают TestValidateSchema* на общих документах).

const kindsDirRel = "../../web/shared/entities/blocks"

type tsBlockKind struct {
	family      string
	carriesText bool
	canShareRow bool
	choice      string // "", "single", "multi"
	// placeholder — показывает ли поле подсказку внутри себя. Зеркало в Go появилось
	// вместе со словарём ассистента (он отказывает в подсказке типу, который её не
	// покажет), и с этого дня свойство сверяется, а не числится непокрытым.
	placeholder bool
}

var (
	reBlockTypes = regexp.MustCompile(`(?s)BLOCK_TYPES = \[(.*?)\] as const`)
	// Цифра в имени типа законна (heading_2/heading_3, 2026-08-22): без неё разбор
	// молча пропускал бы такой тип, и паритет ловил бы «есть в Go, нет на фронте» на
	// ровном месте.
	reQuoted      = regexp.MustCompile(`'([a-z0-9_]+)'`)
	reKindConst   = regexp.MustCompile(`(?s)export const (\w+): BlockKindContract = \{(.*?)\n\}`)
	reFamily      = regexp.MustCompile(`family:\s*'(answer|caption|content)'`)
	reCarriesText = regexp.MustCompile(`carriesText:\s*(true|false)`)
	reCanShareRow = regexp.MustCompile(`canShareRow:\s*(true|false)`)
	reChoice      = regexp.MustCompile(`choice:\s*'(single|multi)'`)
	rePlaceholder = regexp.MustCompile(`supportsPlaceholder:\s*(true|false)`)
	// Реестр в index.ts: и полная запись (`short_text: shortText,`), и сокращённая
	// (`email,` — имя типа совпадает с именем константы).
	reRegistryFull  = regexp.MustCompile(`(?m)^\s{2}([a-z0-9_]+):\s*(\w+),$`)
	reRegistryShort = regexp.MustCompile(`(?m)^\s{2}(\w+),$`)
)

// reLineComment — строчный комментарий TS. Вырезается ПЕРЕД разбором, и это не
// косметика: разбор идёт регулярками по телу литерала, поэтому комментарий вида
// «carriesText: true — текст согласия живёт рядом с галочкой» подменял бы собой реальное
// значение поля, а `'title'`, упомянутый в комментарии внутри BLOCK_TYPES, добавлял в
// список фантомный тип — тест оставался зелёным там, где стороны разошлись (найдено
// ревью этапа 16.1а). Блочных комментариев в файлах реестра нет; появятся — их вырежет
// та же функция, но заметит это тот, кто добавит: разбор упадёт на «не удалось прочитать».
var reLineComment = regexp.MustCompile(`//[^\n]*`)

func readTSFile(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(kindsDirRel, name))
	if err != nil {
		t.Fatalf("реестр типов недоступен (%s): %v", name, err)
	}
	return reLineComment.ReplaceAllString(string(raw), "")
}

// tsKinds — карта «тип блока → его свойства», собранная из файлов реестра.
func tsKinds(t *testing.T) map[BlockType]tsBlockKind {
	t.Helper()

	// 1. Список типов — из contract.ts (он же задаёт значения z.enum).
	m := reBlockTypes.FindStringSubmatch(readTSFile(t, "contract.ts"))
	if m == nil {
		t.Fatal("не удалось прочитать BLOCK_TYPES из blocks/contract.ts")
	}
	var types []BlockType
	seen := map[BlockType]bool{}
	for _, q := range reQuoted.FindAllStringSubmatch(m[1], -1) {
		bt := BlockType(q[1])
		// Дубль в разобранном списке — признак сломавшегося разбора, а не документа:
		// z.enum с повторами не собрался бы. Приезжает он из комментария и маскирует
		// удаление типа.
		if seen[bt] {
			t.Fatalf("тип %s разобран дважды — разбор BLOCK_TYPES сломался", bt)
		}
		seen[bt] = true
		types = append(types, bt)
	}
	if len(types) == 0 {
		t.Fatal("BLOCK_TYPES пуст — разбор contract.ts сломался")
	}

	// 2. Свойства — из файлов типов, по имени экспортируемой константы.
	byConst := map[string]tsBlockKind{}
	entries, err := os.ReadDir(kindsDirRel)
	if err != nil {
		t.Fatalf("каталог реестра недоступен: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".ts") {
			continue
		}
		body := readTSFile(t, e.Name())
		for _, decl := range reKindConst.FindAllStringSubmatch(body, -1) {
			name, fields := decl[1], decl[2]
			fam := reFamily.FindStringSubmatch(fields)
			ct := reCarriesText.FindStringSubmatch(fields)
			sr := reCanShareRow.FindStringSubmatch(fields)
			ph := rePlaceholder.FindStringSubmatch(fields)
			if fam == nil || ct == nil || sr == nil || ph == nil {
				t.Fatalf("не удалось прочитать свойства типа %s (%s): форма файла изменилась", name, e.Name())
			}
			k := tsBlockKind{
				family:      fam[1],
				carriesText: ct[1] == "true",
				canShareRow: sr[1] == "true",
				placeholder: ph[1] == "true",
			}
			if ch := reChoice.FindStringSubmatch(fields); ch != nil {
				k.choice = ch[1]
			}
			byConst[name] = k
		}
	}

	// 3. Связка «тип → константа» — из index.ts.
	index := readTSFile(t, "index.ts")
	regBody := index[strings.Index(index, "BLOCK_KINDS: Record<BlockType, BlockKindContract> = {"):]
	regBody = regBody[:strings.Index(regBody, "\n}")]
	constOf := map[BlockType]string{}
	for _, r := range reRegistryFull.FindAllStringSubmatch(regBody, -1) {
		constOf[BlockType(r[1])] = r[2]
	}
	for _, r := range reRegistryShort.FindAllStringSubmatch(regBody, -1) {
		constOf[BlockType(r[1])] = r[1]
	}

	out := map[BlockType]tsBlockKind{}
	for _, bt := range types {
		name, ok := constOf[bt]
		if !ok {
			t.Fatalf("тип %s есть в BLOCK_TYPES, но не в реестре BLOCK_KINDS", bt)
		}
		kind, ok := byConst[name]
		if !ok {
			t.Fatalf("тип %s ссылается на константу %s, а файла с ней нет", bt, name)
		}
		out[bt] = kind
	}
	return out
}

func TestBlockKindsParityWithFrontend(t *testing.T) {
	kinds := tsKinds(t)

	// Состав множеств: тип, появившийся на одной стороне, обязан появиться на другой.
	for bt := range kinds {
		if !bt.valid() {
			t.Errorf("тип %s есть в реестре фронта, но Go его не принимает (BlockType.valid)", bt)
		}
	}
	// Обратное направление берётся из ТОГО ЖЕ списка, которым живёт valid() (schema.go,
	// blockTypes): свой список здесь был бы вторым набором, отстающим от первого, —
	// тип, добавленный в Go и забытый в тесте, проходил бы паритет, а фронт отвергал бы
	// документ целиком (ревью этапа 16.1а).
	for _, bt := range blockTypes {
		if _, ok := kinds[bt]; !ok {
			t.Errorf("тип %s есть в Go, но у него нет файла в реестре фронта", bt)
		}
	}
	if len(blockTypes) != len(kinds) {
		t.Errorf("число типов разошлось: Go %d, фронт %d", len(blockTypes), len(kinds))
	}

	// Свойства: каждое сверяется со своим предикатом Go.
	for bt, k := range kinds {
		if got, want := bt.isCaption(), k.family == "caption"; got != want {
			t.Errorf("%s: isCaption()=%v, у фронта family=%q", bt, got, k.family)
		}
		if got, want := bt.isContent(), k.family != "answer"; got != want {
			t.Errorf("%s: isContent()=%v, у фронта family=%q", bt, got, k.family)
		}
		if got, want := bt.isAnswerable(), k.family == "answer"; got != want {
			t.Errorf("%s: isAnswerable()=%v, у фронта family=%q", bt, got, k.family)
		}
		if got := bt.carriesText(); got != k.carriesText {
			t.Errorf("%s: carriesText()=%v, у фронта %v", bt, got, k.carriesText)
		}
		if got := bt.canShareRow(); got != k.canShareRow {
			t.Errorf("%s: canShareRow()=%v, у фронта %v", bt, got, k.canShareRow)
		}
		if got, want := bt.isChoice(), k.choice != ""; got != want {
			t.Errorf("%s: isChoice()=%v, у фронта choice=%q", bt, got, k.choice)
		}
		if got, want := bt.isSingleChoice(), k.choice == "single"; got != want {
			t.Errorf("%s: isSingleChoice()=%v, у фронта choice=%q", bt, got, k.choice)
		}
		if got := bt.showsPlaceholder(); got != k.placeholder {
			t.Errorf("%s: showsPlaceholder()=%v, у фронта supportsPlaceholder=%v", bt, got, k.placeholder)
		}
	}
}
