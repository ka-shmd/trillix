package domain

import (
	"strings"
	"testing"
)

// docWithRefs — документ со всеми ПЯТЬЮ видами ссылок на id разом: условие, правая
// часть условия (ссылка на ответ), цели действия (блок и ВАРИАНТ), переход на страницу
// и подстановка ответа. Один документ на все проверки: переадресация обязана быть
// полной, а не «полной для того вида ссылок, про который вспомнил автор теста».
func docWithRefs() FormSchema {
	src := lchoice("src", "g_src", BlockSingleChoice,
		Option{ID: "opt-yes", Label: "Да"},
		Option{ID: "opt-no", Label: "Нет"},
	)
	cap_ := lblk("cap", "g_dep", BlockTitle)
	cap_.Text = []Span{{T: "Привет, "}, {T: "Имя", Ref: "src"}, {T: "!"}}
	dep := lblk("dep", "g_dep", BlockShortText)
	brk := lblk("brk", "g_brk", BlockPageBreak)
	rule := llogic("L", "g_L", all(
		leaf("src", OpIs, "opt-yes"),
		any_(leaf("dep", OpAnswered, "")),
		leafRef("dep", OpIs, "dep2"),
	),
		act(ActShow, "dep", "opt-no"),
		LogicAction{Kind: ActJump, To: "brk"},
	)
	dep2 := lblk("dep2", "g_dep2", BlockShortText)
	return FormSchema{
		SchemaVersion: SchemaVersion,
		Blocks:        []Block{src, cap_, dep, brk, rule, dep2},
	}
}

func blockByOldOrder(s FormSchema, i int) Block { return s.Blocks[i] }

func TestNewSchemaIDs_RewritesEveryID(t *testing.T) {
	src := docWithRefs()
	out := NewSchemaIDs(src)

	if len(out.Blocks) != len(src.Blocks) {
		t.Fatalf("блоков %d, ожидалось %d", len(out.Blocks), len(src.Blocks))
	}

	seen := make(map[string]bool)
	for i, b := range out.Blocks {
		old := blockByOldOrder(src, i)
		if b.ID == old.ID {
			t.Errorf("блок #%d сохранил id %q", i, b.ID)
		}
		if !strings.HasPrefix(b.ID, "blk_") {
			t.Errorf("блок #%d получил id %q без префикса blk_", i, b.ID)
		}
		if seen[b.ID] {
			t.Errorf("id %q выдан дважды", b.ID)
		}
		seen[b.ID] = true
		if b.Type != old.Type {
			t.Errorf("блок #%d сменил тип: %q вместо %q", i, b.Type, old.Type)
		}
	}

	for _, o := range out.Blocks[0].Settings.Options {
		if o.ID == "opt-yes" || o.ID == "opt-no" {
			t.Errorf("вариант сохранил id %q", o.ID)
		}
		if !strings.HasPrefix(o.ID, "opt_") {
			t.Errorf("вариант получил id %q без префикса opt_", o.ID)
		}
	}
	if got := out.Blocks[0].Settings.Options[0].Label; got != "Да" {
		t.Errorf("подпись варианта поехала: %q", got)
	}
}

func TestNewSchemaIDs_GroupFollowsAnchor(t *testing.T) {
	out := NewSchemaIDs(docWithRefs())

	cap_, dep := out.Blocks[1], out.Blocks[2]
	if cap_.GroupID != dep.GroupID {
		t.Fatalf("группа разъехалась: %q и %q", cap_.GroupID, dep.GroupID)
	}
	// Якорь группы «g_dep» — блок dep; новый groupId обязан выводиться из его
	// НОВОГО id, иначе regroup в редакторе перепишет группы на первом открытии.
	if want := groupIDOf(dep.ID); cap_.GroupID != want {
		t.Errorf("groupId %q, ожидался выведенный от якоря %q", cap_.GroupID, want)
	}
	if out.Blocks[0].GroupID == docWithRefs().Blocks[0].GroupID {
		t.Error("groupId одиночного блока не сменился")
	}
}

func TestNewSchemaIDs_GroupWithoutAnchor(t *testing.T) {
	// Документ старше правила «g_ + якорь»: groupId ни на что не указывает.
	// Свежий id обязан быть один на всю группу — связь блоков держит равенство
	// значения, а не его происхождение.
	src := FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{
		lblk("a", "blk_legacy", BlockTitle),
		lblk("b", "blk_legacy", BlockShortText),
	}}
	out := NewSchemaIDs(src)
	if out.Blocks[0].GroupID != out.Blocks[1].GroupID {
		t.Fatalf("группа разъехалась: %q и %q", out.Blocks[0].GroupID, out.Blocks[1].GroupID)
	}
	if out.Blocks[0].GroupID == "blk_legacy" {
		t.Error("groupId без якоря не сменился")
	}
}

func TestNewSchemaIDs_RewritesReferences(t *testing.T) {
	src := docWithRefs()
	out := NewSchemaIDs(src)

	newSrc, newDep, newBrk := out.Blocks[0].ID, out.Blocks[2].ID, out.Blocks[3].ID
	newOptYes, newOptNo := out.Blocks[0].Settings.Options[0].ID, out.Blocks[0].Settings.Options[1].ID
	logic := out.Blocks[4].Logic

	if got := logic.When.All[0].BlockID; got != newSrc {
		t.Errorf("условие смотрит на %q, ожидался %q", got, newSrc)
	}
	if got := logic.When.All[0].Value; got != newOptYes {
		t.Errorf("значение условия %q, ожидался новый id варианта %q", got, newOptYes)
	}
	if got := logic.When.All[1].Any[0].BlockID; got != newDep {
		t.Errorf("вложенное условие смотрит на %q, ожидался %q", got, newDep)
	}
	if got, want := logic.When.All[2].ValueRef, out.Blocks[5].ID; got != want {
		t.Errorf("правая часть ссылается на %q, ожидался %q", got, want)
	}
	if got := logic.Then[0].Targets; got[0] != newDep || got[1] != newOptNo {
		t.Errorf("цели действия %v, ожидались [%s %s]", got, newDep, newOptNo)
	}
	if got := logic.Then[1].To; got != newBrk {
		t.Errorf("переход ведёт на %q, ожидался %q", got, newBrk)
	}
	if got := out.Blocks[1].Text[1].Ref; got != newSrc {
		t.Errorf("подстановка ссылается на %q, ожидался %q", got, newSrc)
	}
	if got := out.Blocks[1].Text[1].T; got != "Имя" {
		t.Errorf("текст подстановки поехал: %q", got)
	}
}

func TestNewSchemaIDs_DanglingRefSurvives(t *testing.T) {
	// Ссылка в никуда была инертной и остаётся ею: подменять её нечем, а
	// «почини или упади» превратило бы законный черновик в ошибку.
	src := FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{
		llogic("L", "g_L", leaf("удалённый", OpIs, "x"), act(ActShow, "тоже-удалённый")),
	}}
	out := NewSchemaIDs(src)
	if got := out.Blocks[0].Logic.When.BlockID; got != "удалённый" {
		t.Errorf("ссылка в никуда переписана в %q", got)
	}
	if got := out.Blocks[0].Logic.Then[0].Targets[0]; got != "тоже-удалённый" {
		t.Errorf("цель в никуда переписана в %q", got)
	}
}

func TestNewSchemaIDs_SourceUntouched(t *testing.T) {
	// Вызов не вправе испортить документ, который ему дали: шаблон в базе
	// переживает создание формы неизменным.
	src := docWithRefs()
	NewSchemaIDs(src)

	if src.Blocks[0].ID != "src" || src.Blocks[0].GroupID != "g_src" {
		t.Errorf("исходный блок изменён: %q / %q", src.Blocks[0].ID, src.Blocks[0].GroupID)
	}
	if src.Blocks[0].Settings.Options[0].ID != "opt-yes" {
		t.Errorf("исходный вариант изменён: %q", src.Blocks[0].Settings.Options[0].ID)
	}
	if src.Blocks[1].Text[1].Ref != "src" {
		t.Errorf("исходная подстановка изменена: %q", src.Blocks[1].Text[1].Ref)
	}
	if src.Blocks[4].Logic.When.All[0].BlockID != "src" {
		t.Errorf("исходное условие изменено: %q", src.Blocks[4].Logic.When.All[0].BlockID)
	}
}

func TestNewSchemaIDs_KeepsDocumentShell(t *testing.T) {
	src := docWithRefs()
	src.SubmitLabel = "Отправить"
	src.ThankYouText = "Спасибо"
	src.Design = &FormDesign{Theme: "dark"}
	out := NewSchemaIDs(src)

	if out.SubmitLabel != "Отправить" || out.ThankYouText != "Спасибо" {
		t.Errorf("оболочка документа поехала: %q / %q", out.SubmitLabel, out.ThankYouText)
	}
	if out.Design == nil || out.Design.Theme != "dark" {
		t.Error("оформление не доехало до копии")
	}
}
