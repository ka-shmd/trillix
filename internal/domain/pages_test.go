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
	f := BuildFunnel(QuestionOrder(versions), PageOrder(versions), FunnelData{Counts: counts})

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
	f := BuildFunnel(threeQuestions(), nil, FunnelData{Counts: []LastBlockCount{{BlockID: "b1", Visits: 3}}})
	if f.Pages != nil {
		t.Fatalf("у одностраничной формы страницы: %+v", f.Pages)
	}
	for _, s := range f.Steps {
		if s.Page != "" {
			t.Fatalf("у шага одностраничной формы страница %q", s.Page)
		}
	}
}

func threePages() []VersionedSchema {
	return []VersionedSchema{vs(1,
		Block{ID: "q1", Type: BlockShortText},
		pb("pb1", "Ветка"),
		Block{ID: "q2", Type: BlockShortText},
		pb("pb2", "Контакты"),
		Block{ID: "q3", Type: BlockShortText},
	)}
}

// Прыгнувший логикой с первой страницы на третью вторую не проходил: она считает
// только открывавших её. Визиты без пути — по порядку документа.
func TestBuildFunnel_PathSkipsPages(t *testing.T) {
	versions := threePages()
	d := FunnelData{
		Counts: []LastBlockCount{
			{BlockID: "q1", Visits: 5},                   // ушли с первой (без пути)
			{BlockID: "q3", Visits: 4},                   // двое прыгнули, двое прошли всё
			{BlockID: "q3", Submitted: true, Visits: 10}, // шестеро прыгнули, четверо прошли всё
			{BlockID: "q2", Visits: 3},                   // собраны до пути: без строк пути
		},
		Paths: []PathCount{
			{LastBlockID: "q3", Blocks: []string{"q3"}, Visits: 2},
			{LastBlockID: "q3", Blocks: []string{"q2", "q3"}, Visits: 2},
			{LastBlockID: "q3", Submitted: true, Blocks: []string{"q3"}, Visits: 6},
			{LastBlockID: "q3", Submitted: true, Blocks: []string{"q2", "q3"}, Visits: 4},
		},
	}
	f := BuildFunnel(QuestionOrder(versions), PageOrder(versions), d)

	want := []struct{ reached, dropped int }{
		{22, 5}, // первую видели все начавшие
		{9, 3},  // вторую: двое и четверо с путём + трое без пути
		{14, 4}, // третью: все, кто на ней закончил
	}
	for i, w := range want {
		if f.Pages[i].Reached != w.reached || f.Pages[i].DroppedHere != w.dropped {
			t.Errorf("страница %d: reached=%d dropped=%d, ждали %d/%d",
				i, f.Pages[i].Reached, f.Pages[i].DroppedHere, w.reached, w.dropped)
		}
	}
	// Вопросы идут тем же правилом: q2 — на перепрыгнутой странице.
	if got := []int{f.Steps[0].Reached, f.Steps[1].Reached, f.Steps[2].Reached}; !reflect.DeepEqual(got, []int{22, 9, 14}) {
		t.Errorf("reached вопросов = %v, ждали [22 9 14]", got)
	}
	if f.Visits != 22 || f.Submitted != 10 {
		t.Errorf("верх воронки %d/%d, ждали 22/10", f.Visits, f.Submitted)
	}
}

// Путь с неизвестным блоком (ручка публична на запись) страниц не добавляет.
func TestBuildFunnel_PathIgnoresUnknownBlocks(t *testing.T) {
	versions := threePages()
	d := FunnelData{
		Counts: []LastBlockCount{{BlockID: "q3", Visits: 1}},
		Paths:  []PathCount{{LastBlockID: "q3", Blocks: []string{"forged", "q3"}, Visits: 1}},
	}
	f := BuildFunnel(QuestionOrder(versions), PageOrder(versions), d)
	if f.Pages[1].Reached != 0 {
		t.Errorf("вторая страница: reached=%d, ждали 0", f.Pages[1].Reached)
	}
}

func TestBuildFunnel_PageTimes(t *testing.T) {
	versions := threePages()
	d := FunnelData{
		Counts: []LastBlockCount{{BlockID: "q1", Visits: 1}},
		Spans: []PageSpan{
			// первая страница: 10, 20, 30, 40 с у прошедших → нижняя медиана 20
			{PageBlock: "", Sec: 10, Visits: 1},
			{PageBlock: "", Sec: 20, Visits: 1},
			{PageBlock: "", Sec: 30, Visits: 1},
			{PageBlock: "", Sec: 40, Visits: 1},
			// вторая: трое по 60 с
			{PageBlock: "q2", Sec: 60, Visits: 3},
			// ушли с третьей
			{PageBlock: "q3", Left: true, Sec: 90, Visits: 2},
			// ушли с первой без пути: дальняя точка на первой — верим
			{PageBlock: "", LastBlock: "q1", Left: true, Sec: 7, Visits: 1},
			// без пути, но дальняя точка на третьей — визит до пути, не первая страница
			{PageBlock: "", LastBlock: "q3", Left: true, Sec: 500, Visits: 5},
			// неизвестный блок
			{PageBlock: "forged", Sec: 1, Visits: 9},
		},
	}
	f := BuildFunnel(QuestionOrder(versions), PageOrder(versions), d)
	got := [][4]int{}
	for _, p := range f.Pages {
		got = append(got, [4]int{p.TimeSec, p.TimeSamples, p.LeftTimeSec, p.LeftSamples})
	}
	want := [][4]int{{20, 4, 7, 1}, {60, 3, 0, 0}, {0, 0, 90, 2}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("время на страницах %v, ждали %v", got, want)
	}
}

// Первая страница документа без вопросов (вступление) — не шаг, её время никуда не
// ложится.
func TestBuildFunnel_PageTimesSkipIntro(t *testing.T) {
	versions := []VersionedSchema{vs(1,
		Block{ID: "t1", Type: BlockText},
		pb("pb1", ""),
		Block{ID: "q1", Type: BlockShortText},
		pb("pb2", ""),
		Block{ID: "q2", Type: BlockShortText},
	)}
	d := FunnelData{Spans: []PageSpan{{PageBlock: "", Sec: 5, Visits: 3}, {PageBlock: "q1", Sec: 8, Visits: 1}}}
	f := BuildFunnel(QuestionOrder(versions), PageOrder(versions), d)
	if f.Pages[0].TimeSamples != 1 || f.Pages[0].TimeSec != 8 {
		t.Errorf("первая страница-шаг: %+v", f.Pages[0])
	}
}
