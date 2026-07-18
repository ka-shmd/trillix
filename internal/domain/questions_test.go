package domain

import "testing"

// vs (сборка VersionedSchema) объявлена в csv_test.go — общая на пакет.

func q(id, label string, t BlockType) Block {
	return Block{ID: id, Label: label, Type: t}
}

func ids(qs []Question) []string {
	out := make([]string, len(qs))
	for i, x := range qs {
		out[i] = x.ID
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Порядок берётся из свежей версии: она главная, её раскладку владелец видит в
// редакторе.
func TestQuestionOrder_FreshestVersionSetsOrder(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vs(1, q("b1", "Имя", BlockShortText), q("b2", "Город", BlockShortText)),
		vs(2, q("b2", "Город", BlockShortText), q("b1", "Имя", BlockShortText)),
	})
	if want := []string{"b2", "b1"}; !equal(ids(got), want) {
		t.Fatalf("порядок = %v, ждали %v (раскладка свежей версии)", ids(got), want)
	}
}

// Вопрос, удалённый в свежей версии, остаётся в модели: по нему собраны ответы
// прежних версий, и спрятать его значило бы спрятать данные.
func TestQuestionOrder_KeepsQuestionRemovedInNewerVersion(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vs(1, q("b1", "Имя", BlockShortText), q("old", "Телефон", BlockPhone)),
		vs(2, q("b1", "Имя", BlockShortText)),
	})
	if want := []string{"b1", "old"}; !equal(ids(got), want) {
		t.Fatalf("порядок = %v, ждали %v (удалённый вопрос сохраняется)", ids(got), want)
	}
}

// Подпись — из свежайшей версии, где блок есть: владелец переименовал вопрос, и в
// отчётах должно стоять новое имя, а не то, под которым отвечали первые.
func TestQuestionOrder_LabelFromFreshestVersionWithBlock(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vs(1, q("b1", "Как вас зовут?", BlockShortText)),
		vs(2, q("b1", "Ваше имя", BlockShortText)),
	})
	if got[0].Label != "Ваше имя" {
		t.Fatalf("подпись = %q, ждали свежую «Ваше имя»", got[0].Label)
	}
}

// Блок без подписи не даёт пустой колонки/шага: фолбэк узнаваем по id.
func TestQuestionOrder_FallbackLabelForUnnamed(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vs(1, q("b1", "   ", BlockShortText))})
	if want := "(без названия) b1"; got[0].Label != want {
		t.Fatalf("подпись = %q, ждали %q", got[0].Label, want)
	}
}

// Неотвечаемые блоки в модель не входят: у них нет ответов, им нечего делать ни в
// колонке выгрузки, ни в шаге воронки.
func TestQuestionOrder_SkipsContentBlocks(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vs(1, q("t1", "Заголовок раздела", BlockText), q("b1", "Имя", BlockShortText)),
	})
	if want := []string{"b1"}; !equal(ids(got), want) {
		t.Fatalf("вопросы = %v, ждали %v (без контентных блоков)", ids(got), want)
	}
}

// Block отдаётся из свежайшей версии — потребителям нужен не только id: сводка
// берёт оттуда диапазон шкалы.
func TestQuestionOrder_BlockIsFromFreshestVersion(t *testing.T) {
	oldScale := Block{ID: "s1", Label: "Оценка", Type: BlockScale}
	newScale := Block{ID: "s1", Label: "Оценка", Type: BlockScale}
	min1, max5 := 1, 5
	min0, max10 := 0, 10
	oldScale.Settings.ScaleMin, oldScale.Settings.ScaleMax = &min1, &max5
	newScale.Settings.ScaleMin, newScale.Settings.ScaleMax = &min0, &max10

	got := QuestionOrder([]VersionedSchema{vs(1, oldScale), vs(2, newScale)})
	if got[0].Block.Settings.ScaleMax == nil || *got[0].Block.Settings.ScaleMax != 10 {
		t.Fatalf("диапазон взят не из свежей версии: %+v", got[0].Block.Settings)
	}
}

func TestQuestionOrder_NoVersions(t *testing.T) {
	if got := QuestionOrder(nil); len(got) != 0 {
		t.Fatalf("без версий ждали пусто, получили %v", ids(got))
	}
}
