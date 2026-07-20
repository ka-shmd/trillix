package domain

import (
	"testing"
)

// Хелперы: vs и ans живут в csv_test.go (тот же пакет) — сводка и выгрузка
// собираются из одних и тех же версий, помощники общие намеренно.

func scaleBlock(id, label string, min, max int) Block {
	b := Block{ID: id, Type: BlockScale}
	b.Settings.ScaleMin, b.Settings.ScaleMax = &min, &max
	return b
}

func choiceBlock(id, label string, typ BlockType, opts ...Option) Block {
	b := Block{ID: id, Type: typ}
	b.Settings.Options = opts
	return b
}

// bucketsOf — деления вопроса как карта Label→Count (порядок проверяется отдельно).
func bucketsOf(t *testing.T, s Summary, blockID string) (BlockSummary, map[string]int) {
	t.Helper()
	for _, b := range s.Blocks {
		if b.BlockID == blockID {
			m := make(map[string]int, len(b.Buckets))
			for _, bk := range b.Buckets {
				m[bk.Label] = bk.Count
			}
			return b, m
		}
	}
	t.Fatalf("вопрос %q отсутствует в сводке", blockID)
	return BlockSummary{}, nil
}

// Одиночный выбор: считаем по id опции, показываем подписью; вариант, который никто
// не выбрал, остаётся в распределении с нулём (иначе бар-чарт врёт о раскладе).
func TestSummary_SingleChoiceDistribution(t *testing.T) {
	src := choiceBlock("q", "Откуда узнали", BlockSingleChoice,
		Option{ID: "o1", Label: "Реклама"},
		Option{ID: "o2", Label: "Друзья"},
		Option{ID: "o3", Label: "Поиск"},
	)
	b := NewSummaryBuilder([]VersionedSchema{vs(1, src)})
	b.Add(1, ans(map[string]any{"q": "o1"}))
	b.Add(1, ans(map[string]any{"q": "o1"}))
	b.Add(1, ans(map[string]any{"q": "o2"}))
	b.Add(1, ans(map[string]any{})) // пропустил вопрос

	sum := b.Result()
	if sum.Total != 4 {
		t.Fatalf("всего ответов = %d, ожидалось 4", sum.Total)
	}
	bs, counts := bucketsOf(t, sum, "q")
	if bs.Kind != SummaryDistribution {
		t.Fatalf("вид сводки = %q, ожидалось распределение", bs.Kind)
	}
	if bs.Asked != 4 || bs.Answered != 3 {
		t.Fatalf("спросили/ответили = %d/%d, ожидалось 4/3", bs.Asked, bs.Answered)
	}
	if counts["Реклама"] != 2 || counts["Друзья"] != 1 {
		t.Fatalf("распределение = %v, ожидалось Реклама:2 Друзья:1", counts)
	}
	if c, ok := counts["Поиск"]; !ok || c != 0 {
		t.Fatalf("невыбранный вариант обязан быть в распределении с нулём: %v", counts)
	}
}

// Выпадающий список — тот же формат ответа, что у single_choice, и обязан давать
// распределение. Ветвление по типу вместо предиката увело бы его в «доля
// заполнивших» — молча, без падения (грабля из README @fields).
func TestSummary_DropdownIsDistributionNotFill(t *testing.T) {
	src := choiceBlock("d", "Город", BlockDropdown,
		Option{ID: "msk", Label: "Москва"},
		Option{ID: "spb", Label: "Питер"},
	)
	b := NewSummaryBuilder([]VersionedSchema{vs(1, src)})
	b.Add(1, ans(map[string]any{"d": "spb"}))

	bs, counts := bucketsOf(t, b.Result(), "d")
	if bs.Kind != SummaryDistribution {
		t.Fatalf("dropdown: вид сводки = %q, ожидалось распределение", bs.Kind)
	}
	if counts["Питер"] != 1 {
		t.Fatalf("dropdown: распределение = %v, ожидалось Питер:1", counts)
	}
}

// Множественный выбор: ответ — массив, каждый выбранный вариант идёт в свой счётчик,
// а сам человек считается ответившим один раз.
func TestSummary_MultiChoiceCountsEachOption(t *testing.T) {
	src := choiceBlock("m", "Что нравится", BlockMultiChoice,
		Option{ID: "a", Label: "Цена"},
		Option{ID: "b", Label: "Скорость"},
	)
	b := NewSummaryBuilder([]VersionedSchema{vs(1, src)})
	b.Add(1, ans(map[string]any{"m": []string{"a", "b"}}))
	b.Add(1, ans(map[string]any{"m": []string{"b"}}))

	bs, counts := bucketsOf(t, b.Result(), "m")
	if counts["Цена"] != 1 || counts["Скорость"] != 2 {
		t.Fatalf("распределение = %v, ожидалось Цена:1 Скорость:2", counts)
	}
	if bs.Answered != 2 {
		t.Fatalf("ответивших = %d, ожидалось 2 (человек, а не галочек)", bs.Answered)
	}
}

// Шкала: деления от min до max включительно, даже нулевые; ответ по версии с более
// широким диапазоном не теряется, а встаёт на место по числу.
func TestSummary_ScaleBucketsCoverRange(t *testing.T) {
	nps := scaleBlock("s", "Оценка", 0, 10)
	narrow := scaleBlock("s", "Оценка", 1, 5)

	b := NewSummaryBuilder([]VersionedSchema{vs(1, nps), vs(2, narrow)})
	b.Add(1, ans(map[string]any{"s": "9"})) // вне диапазона свежей версии
	b.Add(2, ans(map[string]any{"s": "5"}))
	b.Add(2, ans(map[string]any{"s": "5"}))

	bs, counts := bucketsOf(t, b.Result(), "s")
	if bs.Kind != SummaryDistribution {
		t.Fatalf("шкала: вид сводки = %q, ожидалось распределение", bs.Kind)
	}
	if counts["5"] != 2 || counts["9"] != 1 {
		t.Fatalf("распределение = %v, ожидалось 5:2 9:1", counts)
	}
	if c, ok := counts["3"]; !ok || c != 0 {
		t.Fatalf("деление без ответов обязано быть в распределении: %v", counts)
	}
	// Порядок — по числу, не по порядку встречи: 1,2,3,4,5,9.
	want := []string{"1", "2", "3", "4", "5", "9"}
	if len(bs.Buckets) != len(want) {
		t.Fatalf("делений = %d (%v), ожидалось %v", len(bs.Buckets), bs.Buckets, want)
	}
	for i, w := range want {
		if bs.Buckets[i].Label != w {
			t.Fatalf("деление %d = %q, ожидалось %q (сортировка по числу)", i, bs.Buckets[i].Label, w)
		}
	}
}

// Согласие: «Нет» — это те, кого спросили и кто не отметил, а не только приславшие
// пустую строку. Неотмеченный чекбокс приходит и пустым значением, и вовсе без
// ключа — обе формы обязаны попасть в «Нет» одинаково.
func TestSummary_ConsentNoCountsUnchecked(t *testing.T) {
	src := Block{ID: "c", Type: BlockConsent}
	b := NewSummaryBuilder([]VersionedSchema{vs(1, src)})
	b.Add(1, ans(map[string]any{"c": ConsentYes}))
	b.Add(1, ans(map[string]any{"c": ""})) // снял галочку
	b.Add(1, ans(map[string]any{}))        // не трогал вовсе

	bs, counts := bucketsOf(t, b.Result(), "c")
	if counts["Да"] != 1 {
		t.Fatalf("согласий = %d, ожидалось 1 (%v)", counts["Да"], counts)
	}
	if counts["Нет"] != 2 {
		t.Fatalf("отказов = %d, ожидалось 2 — пустое значение и отсутствие ключа равны (%v)", counts["Нет"], counts)
	}
	if bs.Asked != 3 {
		t.Fatalf("спросили = %d, ожидалось 3", bs.Asked)
	}
}

// Числа: среднее/мин/макс по ответившим, а не по всем ответам формы.
func TestSummary_NumberStats(t *testing.T) {
	src := Block{ID: "n", Type: BlockNumber}
	b := NewSummaryBuilder([]VersionedSchema{vs(1, src)})
	b.Add(1, ans(map[string]any{"n": "10"}))
	b.Add(1, ans(map[string]any{"n": "20"}))
	b.Add(1, ans(map[string]any{"n": "30"}))
	b.Add(1, ans(map[string]any{})) // пропустил

	bs, _ := bucketsOf(t, b.Result(), "n")
	if bs.Kind != SummaryNumber {
		t.Fatalf("вид сводки = %q, ожидались числа", bs.Kind)
	}
	if bs.Number == nil {
		t.Fatal("статистика не собрана")
	}
	if bs.Number.Avg != 20 || bs.Number.Min != 10 || bs.Number.Max != 30 {
		t.Fatalf("среднее/мин/макс = %v, ожидалось 20/10/30 (пропуск не занижает среднее)", *bs.Number)
	}
}

// Числовой вопрос без единого ответа: статистики нет (а не среднее 0 — это разные
// утверждения, и ноль на экране владельца был бы враньём).
func TestSummary_NumberWithoutAnswersHasNoStats(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, Block{ID: "n", Type: BlockNumber})})
	b.Add(1, ans(map[string]any{}))

	bs, _ := bucketsOf(t, b.Result(), "n")
	if bs.Number != nil {
		t.Fatalf("статистика без ответов = %v, ожидалось отсутствие", *bs.Number)
	}
}

// Свободный текст: только доля заполнивших; пробельный ответ — не ответ.
func TestSummary_TextIsFillRate(t *testing.T) {
	b := NewSummaryBuilder([]VersionedSchema{vs(1, Block{ID: "t", Type: BlockLongText})})
	b.Add(1, ans(map[string]any{"t": "всё понравилось"}))
	b.Add(1, ans(map[string]any{"t": "   "}))
	b.Add(1, ans(map[string]any{}))

	bs, _ := bucketsOf(t, b.Result(), "t")
	if bs.Kind != SummaryFill {
		t.Fatalf("вид сводки = %q, ожидалась доля заполнивших", bs.Kind)
	}
	if bs.Asked != 3 || bs.Answered != 1 {
		t.Fatalf("спросили/ответили = %d/%d, ожидалось 3/1 (пробелы — не ответ)", bs.Asked, bs.Answered)
	}
}

// Знаменатель — по версиям, где вопрос БЫЛ: добавленный в v2 не выглядит
// пропущенным у всех, кто отвечал по v1.
func TestSummary_AskedCountsOnlyVersionsWithBlock(t *testing.T) {
	old := Block{ID: "a", Type: BlockShortText}
	added := Block{ID: "b", Type: BlockShortText}

	bld := NewSummaryBuilder([]VersionedSchema{vs(1, old), vs(2, old, added)})
	bld.Add(1, ans(map[string]any{"a": "Аня"}))
	bld.Add(2, ans(map[string]any{"a": "Боря", "b": "Тверь"}))

	sum := bld.Result()
	city, _ := bucketsOf(t, sum, "b")
	if city.Asked != 1 || city.Answered != 1 {
		t.Fatalf("вопрос из v2: спросили/ответили = %d/%d, ожидалось 1/1 (ответ по v1 в знаменатель не идёт)",
			city.Asked, city.Answered)
	}
	name, _ := bucketsOf(t, sum, "a")
	if name.Asked != 2 {
		t.Fatalf("вопрос из обеих версий: спросили = %d, ожидалось 2", name.Asked)
	}
}

// Вопрос, удалённый в свежей версии, остаётся в сводке (правило колонок CSV):
// ответы по нему собраны и прятать их нельзя. Порядок — свежая версия слева,
// выбывшие следом.
func TestSummary_KeepsBlocksOfOldVersions(t *testing.T) {
	bld := NewSummaryBuilder([]VersionedSchema{
		vsg(1, grp("Имя v1", Block{ID: "a", Type: BlockShortText}), grp("Телефон", Block{ID: "g", Type: BlockShortText})),
		vsg(2, grp("Имя v2", Block{ID: "a", Type: BlockShortText}), grp("Город", Block{ID: "n", Type: BlockShortText})),
	})
	bld.Add(1, ans(map[string]any{"g": "+79990000000"}))

	sum := bld.Result()
	order := make([]string, 0, len(sum.Blocks))
	for _, b := range sum.Blocks {
		order = append(order, b.BlockID)
	}
	want := []string{"a", "n", "g"}
	if len(order) != len(want) {
		t.Fatalf("вопросы сводки = %v, ожидались %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("вопрос %d = %q, ожидался %q", i, order[i], want[i])
		}
	}
	phone, _ := bucketsOf(t, sum, "g")
	if phone.Answered != 1 {
		t.Fatalf("ответ на удалённый вопрос потерян: ответивших = %d", phone.Answered)
	}
	// Подпись — из свежайшей версии, где блок есть (как в CSV).
	name, _ := bucketsOf(t, sum, "a")
	if name.Label != "Имя v2" {
		t.Fatalf("подпись = %q, ожидалась «Имя v2» (свежайшая версия)", name.Label)
	}
}

// Неотвечаемые блоки (text, image) в сводку не попадают — у них нет ответов.
func TestSummary_ExcludesContentBlocks(t *testing.T) {
	intro := Block{ID: "i", Type: BlockText}
	pic := Block{ID: "p", Type: BlockImage}
	name := Block{ID: "n", Type: BlockShortText}

	b := NewSummaryBuilder([]VersionedSchema{vs(1, intro, pic, name)})
	b.Add(1, ans(map[string]any{"n": "Аня"}))

	sum := b.Result()
	if len(sum.Blocks) != 1 || sum.Blocks[0].BlockID != "n" {
		t.Fatalf("вопросы сводки = %v, ожидался только «n»", sum.Blocks)
	}
}

// Вариант, удалённый из опций в свежей версии: ответы по нему не исчезают, а
// показываются в конце (id вместо подписи — как в CSV).
func TestSummary_UnknownOptionSurvives(t *testing.T) {
	v1 := choiceBlock("q", "Выбор", BlockSingleChoice,
		Option{ID: "keep", Label: "Оставили"},
		Option{ID: "dropped", Label: "Убрали"},
	)
	v2 := choiceBlock("q", "Выбор", BlockSingleChoice, Option{ID: "keep", Label: "Оставили"})

	// Опция dropped есть в v1 — она попадёт в объединение с подписью «Убрали».
	b := NewSummaryBuilder([]VersionedSchema{vs(1, v1), vs(2, v2)})
	b.Add(1, ans(map[string]any{"q": "dropped"}))
	_, counts := bucketsOf(t, b.Result(), "q")
	if counts["Убрали"] != 1 {
		t.Fatalf("ответ по убранному варианту потерян: %v", counts)
	}

	// Опции нет ни в одной версии (рассинхрон) — показываем сырой id, факт ответа
	// не теряем.
	b2 := NewSummaryBuilder([]VersionedSchema{vs(1, v2)})
	b2.Add(1, ans(map[string]any{"q": "ghost"}))
	_, counts2 := bucketsOf(t, b2.Result(), "q")
	if counts2["ghost"] != 1 {
		t.Fatalf("ответ по неизвестному варианту потерян: %v", counts2)
	}
}

// Ответ на блок, которого в версии ответа не было (устаревшая вкладка, ручной
// запрос), в сводку не идёт — иначе распределение считало бы то, чего человек не
// видел. Зеркалит пустую ячейку CSV в той же ситуации.
func TestSummary_IgnoresAnswerAbsentFromItsVersion(t *testing.T) {
	old := Block{ID: "a", Type: BlockShortText}
	added := Block{ID: "b", Type: BlockShortText}

	bld := NewSummaryBuilder([]VersionedSchema{vs(1, old), vs(2, old, added)})
	bld.Add(1, ans(map[string]any{"a": "Аня", "b": "Тверь"})) // b в v1 не было

	city, _ := bucketsOf(t, bld.Result(), "b")
	if city.Asked != 0 || city.Answered != 0 {
		t.Fatalf("спросили/ответили = %d/%d, ожидалось 0/0", city.Asked, city.Answered)
	}
}
