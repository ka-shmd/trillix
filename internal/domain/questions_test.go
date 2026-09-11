package domain

import "testing"

// vs/vsg/grp/content (сборка VersionedSchema и групп) объявлены в csv_test.go —
// общие на пакет.

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
		vsg(1, grp("Имя", Block{ID: "b1", Type: BlockShortText}), grp("Город", Block{ID: "b2", Type: BlockShortText})),
		vsg(2, grp("Город", Block{ID: "b2", Type: BlockShortText}), grp("Имя", Block{ID: "b1", Type: BlockShortText})),
	})
	if want := []string{"b2", "b1"}; !equal(ids(got), want) {
		t.Fatalf("порядок = %v, ждали %v (раскладка свежей версии)", ids(got), want)
	}
}

// Вопрос, удалённый в свежей версии, остаётся в модели: по нему собраны ответы
// прежних версий, и спрятать его значило бы спрятать данные.
func TestQuestionOrder_KeepsQuestionRemovedInNewerVersion(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vsg(1, grp("Имя", Block{ID: "b1", Type: BlockShortText}), grp("Телефон", Block{ID: "old", Type: BlockPhone})),
		vsg(2, grp("Имя", Block{ID: "b1", Type: BlockShortText})),
	})
	if want := []string{"b1", "old"}; !equal(ids(got), want) {
		t.Fatalf("порядок = %v, ждали %v (удалённый вопрос сохраняется)", ids(got), want)
	}
}

// Подпись — из свежайшей версии, где блок есть: владелец переименовал вопрос, и в
// отчётах должно стоять новое имя, а не то, под которым отвечали первые.
func TestQuestionOrder_LabelFromFreshestVersionWithBlock(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vsg(1, grp("Как вас зовут?", Block{ID: "b1", Type: BlockShortText})),
		vsg(2, grp("Ваше имя", Block{ID: "b1", Type: BlockShortText})),
	})
	if got[0].Label != "Ваше имя" {
		t.Fatalf("подпись = %q, ждали свежую «Ваше имя»", got[0].Label)
	}
}

// Имя вопроса (фаза 16, ADR §10) перебивает ВСЁ: заголовок пишется для респондента,
// имя — для данных, и когда автор их развёл, колонка называется именем.
func TestQuestionOrder_ExplicitNameWins(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vs(1,
		Block{ID: "t1", GroupID: "g1", Type: BlockTitle, Text: TextFromString("Как вас зовут?")},
		Block{ID: "b1", GroupID: "g1", Type: BlockShortText, Name: "fio"},
	)})
	if got[0].Label != "fio" {
		t.Fatalf("подпись = %q, ждали имя «fio» (имя перебивает заголовок)", got[0].Label)
	}
}

// Имя из одних пробелов — не имя: вывод продолжается с подписи группы. Иначе колонка
// в выгрузке называлась бы пустотой, а именно этого questionLabel и не допускает.
func TestQuestionOrder_BlankNameFallsThrough(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vs(1,
		Block{ID: "t1", GroupID: "g1", Type: BlockTitle, Text: TextFromString("Как вас зовут?")},
		Block{ID: "b1", GroupID: "g1", Type: BlockShortText, Name: "   "},
	)})
	if got[0].Label != "Как вас зовут?" {
		t.Fatalf("подпись = %q, ждали заголовок (пробельное имя не считается)", got[0].Label)
	}
}

// Имя, как и подпись, берётся из свежайшей версии, где блок есть: переименование
// меняет заголовок колонки и для ранее собранных ответов (ADR §10 — осознанно).
func TestQuestionOrder_NameFromFreshestVersionWithBlock(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vs(1, Block{ID: "b1", GroupID: "g1", Type: BlockShortText, Name: "q1"}),
		vs(2, Block{ID: "b1", GroupID: "g1", Type: BlockShortText, Name: "fio"}),
	})
	if got[0].Label != "fio" {
		t.Fatalf("подпись = %q, ждали свежее имя «fio»", got[0].Label)
	}
}

// Подпись берётся из блока-подписи ГРУППЫ, а не из самого поля (v2). title
// перебивает label; связь — по groupId.
func TestQuestionOrder_CaptionFromGroupTitle(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vs(1,
		Block{ID: "l1", GroupID: "g1", Type: BlockLabel, Text: TextFromString("мелкая")},
		Block{ID: "t1", GroupID: "g1", Type: BlockTitle, Text: TextFromString("Крупная подпись")},
		Block{ID: "b1", GroupID: "g1", Type: BlockShortText},
	)})
	if got[0].Label != "Крупная подпись" {
		t.Fatalf("подпись = %q, ждали title «Крупная подпись» (title перебивает label)", got[0].Label)
	}
}

// Перетаскивание не переклеивает подпись: title стоит ПОСЛЕ поля в списке, но связь
// по groupId, поэтому подпись всё равно достаётся полю своей группы.
func TestQuestionOrder_CaptionByGroupNotPosition(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vs(1,
		Block{ID: "b1", GroupID: "g1", Type: BlockShortText},
		Block{ID: "t1", GroupID: "g1", Type: BlockTitle, Text: TextFromString("Имя")},
	)})
	if got[0].Label != "Имя" {
		t.Fatalf("подпись = %q, ждали «Имя» (по группе, а не по позиции)", got[0].Label)
	}
}

// Голое поле без подписи: подпись генерируется из плейсхолдера.
func TestQuestionOrder_GeneratedFromPlaceholder(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vs(1,
		Block{ID: "b1", GroupID: "g1", Type: BlockEmail, Settings: BlockSettings{Placeholder: "you@example.com"}},
	)})
	if got[0].Label != "you@example.com" {
		t.Fatalf("подпись = %q, ждали плейсхолдер", got[0].Label)
	}
}

// Голое поле совсем без подсказок: генерируется «Тип N».
func TestQuestionOrder_GeneratedFromTypeAndOrdinal(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vsg(1,
		grp("", Block{ID: "b1", Type: BlockShortText}),
		grp("", Block{ID: "b2", Type: BlockEmail}),
	)})
	if got[0].Label != "Короткий ответ 1" {
		t.Fatalf("подпись[0] = %q, ждали «Короткий ответ 1»", got[0].Label)
	}
	if got[1].Label != "Email 2" {
		t.Fatalf("подпись[1] = %q, ждали «Email 2»", got[1].Label)
	}
}

// У каждого отвечаемого типа есть человеческое имя: забытый тип получает в «Тип N»
// своё имя из схемы латиницей («slot 3») — в заголовке колонки CSV и шаге воронки.
func TestBlockTypeNames_CoverAnswerableTypes(t *testing.T) {
	for _, bt := range blockTypes {
		if bt.isAnswerable() && blockTypeNames[bt] == "" {
			t.Errorf("у отвечаемого типа %s нет имени в blockTypeNames", bt)
		}
	}
}

// consent несёт собственный текст согласия — он и становится подписью, отдельного
// title не нужно.
func TestQuestionOrder_ConsentOwnTextAsCaption(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{vs(1,
		Block{ID: "c1", GroupID: "g1", Type: BlockConsent, Text: TextFromString("Соглашаюсь с обработкой данных")},
	)})
	if got[0].Label != "Соглашаюсь с обработкой данных" {
		t.Fatalf("подпись = %q, ждали текст согласия", got[0].Label)
	}
}

// Неотвечаемые блоки (подписи и контент) в модель не входят: у них нет ответов, им
// нечего делать ни в колонке выгрузки, ни в шаге воронки.
func TestQuestionOrder_SkipsContentBlocks(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vsg(1, content("t1", BlockHeading, "Заголовок раздела"), grp("Имя", Block{ID: "b1", Type: BlockShortText})),
	})
	if want := []string{"b1"}; !equal(ids(got), want) {
		t.Fatalf("вопросы = %v, ждали %v (без контентных блоков)", ids(got), want)
	}
}

// Block отдаётся из свежайшей версии — потребителям нужен не только id: сводка
// берёт оттуда диапазон шкалы.
func TestQuestionOrder_BlockIsFromFreshestVersion(t *testing.T) {
	oldScale := Block{ID: "s1", GroupID: "g1", Type: BlockScale}
	newScale := Block{ID: "s1", GroupID: "g1", Type: BlockScale}
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

// Разрыв страницы в модели вопросов не участвует: он неотвечаемый, значит ни колонки в
// CSV, ни шага воронки, ни ключа в сводке у него нет. Правило общее для всего контента —
// проверяем на разрыве отдельно, потому что именно он приходит НЕ от автора текста, а от
// раскладки, и «лишний вопрос» здесь был бы виден владельцу на трёх экранах сразу.
func TestQuestionOrder_SkipsPageBreak(t *testing.T) {
	got := QuestionOrder([]VersionedSchema{
		vsg(1,
			grp("Имя", Block{ID: "b1", Type: BlockShortText}),
			[]Block{{ID: "p1", GroupID: "g_p1", Type: BlockPageBreak}},
			grp("Почта", Block{ID: "b2", Type: BlockEmail}),
		),
	})
	if want := []string{"b1", "b2"}; !equal(ids(got), want) {
		t.Fatalf("вопросы = %v, ждали %v (разрыв — не вопрос)", ids(got), want)
	}
}
