package domain

import (
	"reflect"
	"testing"
)

func pb(id, name string) Block {
	return Block{ID: id, Type: BlockPageBreak, Settings: BlockSettings{PageName: name}}
}

func pageKeys(pages []Page) []string {
	out := make([]string, len(pages))
	for i, p := range pages {
		out[i] = p.Key
	}
	return out
}

func TestPageOrder_SinglePageIsNil(t *testing.T) {
	v := vsg(1, grp("Имя", Block{ID: "q1", Type: BlockShortText}), grp("Почта", Block{ID: "q2", Type: BlockEmail}))
	if got := PageOrder([]VersionedSchema{v}); got != nil {
		t.Fatalf("одностраничная форма дала страницы: %+v", got)
	}
}

// Вступление без вопросов шагом не бывает, поэтому «вступление + одна страница
// вопросов» — одностраничная воронка.
func TestPageOrder_IntroDoesNotMakeFormMultipage(t *testing.T) {
	v := vs(1,
		Block{ID: "t1", Type: BlockText},
		pb("pb1", ""),
		Block{ID: "q1", Type: BlockShortText},
	)
	if got := PageOrder([]VersionedSchema{v}); got != nil {
		t.Fatalf("ждали nil, получили %+v", got)
	}
}

func TestPageOrder_KeysLabelsAndQuestions(t *testing.T) {
	v := vs(1,
		Block{ID: "q1", Type: BlockShortText},
		pb("pb1", "  Контакты "),
		Block{ID: "q2", Type: BlockEmail},
		Block{ID: "q3", Type: BlockPhone},
		pb("pb2", ""),
		Block{ID: "q4", Type: BlockLongText},
	)
	got := PageOrder([]VersionedSchema{v})
	want := []Page{
		{Key: "", Label: "Страница 1", QuestionIDs: []string{"q1"}},
		{Key: "pb1", Label: "Контакты", QuestionIDs: []string{"q2", "q3"}},
		{Key: "pb2", Label: "Страница 3", QuestionIDs: []string{"q4"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PageOrder:\n got %+v\nwant %+v", got, want)
	}
}

// Номер в подписи считается по всем страницам, включая вступление: так страницу
// нумерует полотно (pageNumbers в @fields/groups).
func TestPageOrder_NumberCountsPagesWithoutQuestions(t *testing.T) {
	v := vs(1,
		Block{ID: "t1", Type: BlockText},
		pb("pb1", ""),
		Block{ID: "q1", Type: BlockShortText},
		pb("pb2", ""),
		Block{ID: "q2", Type: BlockShortText},
	)
	got := PageOrder([]VersionedSchema{v})
	if len(got) != 2 || got[0].Label != "Страница 2" || got[1].Label != "Страница 3" {
		t.Fatalf("подписи: %+v", got)
	}
}

// Два разрыва подряд: страницу открывает ПОСЛЕДНИЙ, и имя берётся с него — как на
// полотне. Первый из двух инертен.
func TestPageOrder_DoubleBreakNamesByLastBreak(t *testing.T) {
	v := vs(1,
		Block{ID: "q1", Type: BlockShortText},
		pb("pb1", "Инертный"),
		pb("pb2", "Контакты"),
		Block{ID: "q2", Type: BlockShortText},
	)
	got := PageOrder([]VersionedSchema{v})
	if len(got) != 2 || got[1].Key != "pb2" || got[1].Label != "Контакты" {
		t.Fatalf("страница за двумя разрывами: %+v", got)
	}
}

// Разрыв первым блоком инертен и первую страницу не открывает: её ключ пуст, имени нет.
func TestPageOrder_LeadingBreakDoesNotOpenFirstPage(t *testing.T) {
	v := vs(1,
		pb("pb0", "Не имя"),
		Block{ID: "q1", Type: BlockShortText},
		pb("pb1", ""),
		Block{ID: "q2", Type: BlockShortText},
	)
	got := PageOrder([]VersionedSchema{v})
	if len(got) != 2 || got[0].Key != "" || got[0].Label != "Страница 1" {
		t.Fatalf("первая страница: %+v", got)
	}
}

// Экран «Спасибо» — страница без вопросов, шагом не бывает.
func TestPageOrder_ThankYouIsNotAStep(t *testing.T) {
	ty := pb("pb9", "")
	ty.Settings.ThankYou = true
	v := vs(1,
		Block{ID: "q1", Type: BlockShortText},
		pb("pb1", ""),
		Block{ID: "q2", Type: BlockShortText},
		ty,
		Block{ID: "t9", Type: BlockText},
	)
	if got := pageKeys(PageOrder([]VersionedSchema{v})); !reflect.DeepEqual(got, []string{"", "pb1"}) {
		t.Fatalf("ключи: %v", got)
	}
}

// Вопрос, удалённый в свежей версии, остаётся на своей странице (по свежайшей версии,
// где он есть) — в её конце; страница, которой в свежей версии нет, встаёт в конец.
func TestPageOrder_OldVersionsKeepTheirQuestionsAndPages(t *testing.T) {
	v1 := vs(1,
		Block{ID: "q1", Type: BlockShortText},
		Block{ID: "old", Type: BlockShortText},
		pb("pbGone", "Старая"),
		Block{ID: "q9", Type: BlockShortText},
	)
	v2 := vs(2,
		Block{ID: "q1", Type: BlockShortText},
		pb("pb1", "Новая"),
		Block{ID: "q2", Type: BlockShortText},
	)
	got := PageOrder([]VersionedSchema{v1, v2})
	want := []Page{
		{Key: "", Label: "Страница 1", QuestionIDs: []string{"q1", "old"}},
		{Key: "pb1", Label: "Новая", QuestionIDs: []string{"q2"}},
		{Key: "pbGone", Label: "Старая", QuestionIDs: []string{"q9"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PageOrder:\n got %+v\nwant %+v", got, want)
	}
}

// Вопрос, перенесённый на другую страницу, принадлежит странице свежей версии.
func TestPageOrder_MovedQuestionFollowsFreshestVersion(t *testing.T) {
	v1 := vs(1,
		Block{ID: "q1", Type: BlockShortText},
		Block{ID: "q2", Type: BlockShortText},
		pb("pb1", ""),
		Block{ID: "q3", Type: BlockShortText},
	)
	v2 := vs(2,
		Block{ID: "q1", Type: BlockShortText},
		pb("pb1", ""),
		Block{ID: "q2", Type: BlockShortText},
		Block{ID: "q3", Type: BlockShortText},
	)
	got := PageOrder([]VersionedSchema{v1, v2})
	if len(got) != 2 || !reflect.DeepEqual(got[1].QuestionIDs, []string{"q2", "q3"}) {
		t.Fatalf("страницы: %+v", got)
	}
}

// Воронка многостраничной формы: вопросы идут по страницам (удалённый вопрос —
// в конце своей страницы), страница берёт «дошли» у первого вопроса и сумму отвалов.
func TestBuildFunnel_Pages(t *testing.T) {
	versions := []VersionedSchema{
		vs(1,
			Block{ID: "q1", Type: BlockShortText},
			Block{ID: "old", Type: BlockShortText},
			pb("pb1", ""),
			Block{ID: "q2", Type: BlockShortText},
		),
		vs(2,
			Block{ID: "q1", Type: BlockShortText},
			pb("pb1", "Контакты"),
			Block{ID: "q2", Type: BlockShortText},
			Block{ID: "q3", Type: BlockShortText},
		),
	}
	counts := []LastBlockCount{
		{BlockID: "", Visits: 7},
		{BlockID: "q1", Visits: 10},
		{BlockID: "old", Visits: 4},
		{BlockID: "q2", Visits: 6},
		{BlockID: "q3", Visits: 3},
		{BlockID: "q3", Submitted: true, Visits: 20},
	}
	f := BuildFunnel(QuestionOrder(versions), PageOrder(versions), counts)

	var order []string
	for _, s := range f.Steps {
		order = append(order, s.Page+"/"+s.BlockID)
	}
	if want := []string{"/q1", "/old", "pb1/q2", "pb1/q3"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("порядок шагов %v, ждали %v", order, want)
	}
	want := []FunnelPage{
		{Key: "", Label: "Страница 1", Reached: 43, DroppedHere: 14},
		{Key: "pb1", Label: "Контакты", Reached: 29, DroppedHere: 9},
	}
	if !reflect.DeepEqual(f.Pages, want) {
		t.Fatalf("страницы:\n got %+v\nwant %+v", f.Pages, want)
	}
}

func TestBuildFunnel_SinglePageHasNoPages(t *testing.T) {
	f := BuildFunnel(threeQuestions(), nil, []LastBlockCount{{BlockID: "b1", Visits: 3}})
	if f.Pages != nil {
		t.Fatalf("у одностраничной формы страницы: %+v", f.Pages)
	}
	for _, s := range f.Steps {
		if s.Page != "" {
			t.Fatalf("у шага одностраничной формы страница %q", s.Page)
		}
	}
}
