package domain

import "testing"

func threeQuestions() []Question {
	return QuestionOrder([]VersionedSchema{
		vsg(1,
			grp("Имя", Block{ID: "b1", Type: BlockShortText}),
			grp("ИНН", Block{ID: "b2", Type: BlockShortText}),
			grp("Комментарий", Block{ID: "b3", Type: BlockLongText}),
		),
	})
}

// Базовый случай: 100 открыли, 20 не начали, дальше отваливаются по вопросам.
// Reached невозрастает, DroppedHere показывает виновника.
func TestBuildFunnel_ReachedAndDropped(t *testing.T) {
	counts := []LastBlockCount{
		{BlockID: "", Visits: 20},                    // не начали
		{BlockID: "b1", Visits: 14},                  // бросили на «Имя»
		{BlockID: "b2", Visits: 51},                  // бросили на «ИНН» — виновник
		{BlockID: "b3", Visits: 5},                   // бросили на «Комментарии»
		{BlockID: "b3", Submitted: true, Visits: 10}, // отправили
	}
	f := BuildFunnel(threeQuestions(), counts)

	if f.LeftBeforeFirst != 20 {
		t.Errorf("LeftBeforeFirst = %d, ждали 20", f.LeftBeforeFirst)
	}
	want := []struct{ reached, dropped int }{
		{80, 14}, // b1: 14+51+5+10
		{66, 51}, // b2: 51+5+10
		{15, 5},  // b3: 5+10, отправившие не отвал
	}
	for i, w := range want {
		if f.Steps[i].Reached != w.reached || f.Steps[i].DroppedHere != w.dropped {
			t.Errorf("шаг %d (%s): reached=%d dropped=%d, ждали %d/%d",
				i, f.Steps[i].BlockID, f.Steps[i].Reached, f.Steps[i].DroppedHere, w.reached, w.dropped)
		}
	}
	for i := 1; i < len(f.Steps); i++ {
		if f.Steps[i].Reached > f.Steps[i-1].Reached {
			t.Errorf("Reached вырос на шаге %d — воронка не сужается", i)
		}
	}
}

// Верх воронки выводится из той же разбивки, что и шаги, а не приходит отдельным
// счётчиком: сумма всех групп = визиты, сумма групп с submitted = конверсия. Тест
// падает, если кто-то снова заведёт второй источник этих чисел — он мог бы
// разойтись с шагами.
func TestBuildFunnel_TotalsDerivedFromCounts(t *testing.T) {
	counts := []LastBlockCount{
		{BlockID: "", Visits: 20},
		{BlockID: "b1", Visits: 14},
		{BlockID: "b2", Visits: 51},
		{BlockID: "b3", Visits: 5},
		{BlockID: "b3", Submitted: true, Visits: 10},
	}
	f := BuildFunnel(threeQuestions(), counts)

	if f.Visits != 100 {
		t.Errorf("Visits = %d, ждали 100 (сумма всех групп)", f.Visits)
	}
	if f.Submitted != 10 {
		t.Errorf("Submitted = %d, ждали 10 (сумма групп с submitted)", f.Submitted)
	}
}

// Главная ловушка воронки: отправивший форму тоже остановился на последнем поле,
// которого коснулся. Если считать его отвалом, экран обвинит последний вопрос —
// именно тот, который люди успешно проходят.
func TestBuildFunnel_SubmittedIsNotADrop(t *testing.T) {
	counts := []LastBlockCount{{BlockID: "b3", Submitted: true, Visits: 40}}
	f := BuildFunnel(threeQuestions(), counts)

	if f.Steps[2].DroppedHere != 0 {
		t.Fatalf("DroppedHere последнего вопроса = %d, ждали 0: все 40 отправили форму, "+
			"это не отвал", f.Steps[2].DroppedHere)
	}
	if f.Steps[2].Reached != 40 {
		t.Errorf("Reached последнего = %d, ждали 40 (дошли все)", f.Steps[2].Reached)
	}
}

// Обратная сторона той же ловушки: форма со всеми необязательными вопросами
// позволяет нажать «Отправить», не тронув ни одного поля. Это не уход до первого
// вопроса.
func TestBuildFunnel_SubmittedWithoutTouchingIsNotLeft(t *testing.T) {
	counts := []LastBlockCount{
		{BlockID: "", Submitted: true, Visits: 7},
		{BlockID: "", Visits: 3},
	}
	f := BuildFunnel(threeQuestions(), counts)

	if f.LeftBeforeFirst != 3 {
		t.Fatalf("LeftBeforeFirst = %d, ждали 3: отправившие без касаний не ушли", f.LeftBeforeFirst)
	}
}

// Подделанный или устаревший block_id к соседнему вопросу не приписывается: ручка
// визитов публична на запись, и мусор не должен искажать реальный шаг.
func TestBuildFunnel_UnknownBlockIsNotAttributed(t *testing.T) {
	counts := []LastBlockCount{
		{BlockID: "b1", Visits: 5},
		{BlockID: "подделка", Visits: 999},
	}
	f := BuildFunnel(threeQuestions(), counts)

	if f.Steps[0].Reached != 5 || f.Steps[0].DroppedHere != 5 {
		t.Fatalf("шаг b1: reached=%d dropped=%d, ждали 5/5 — чужой id подмешался",
			f.Steps[0].Reached, f.Steps[0].DroppedHere)
	}
	// Визиты остаются в общем счётчике: они были, врать про них нельзя.
	if f.Visits != 1004 {
		t.Errorf("Visits = %d, ждали 1004", f.Visits)
	}
}

// Вопрос, удалённый из свежей версии, остаётся шагом: по нему уходили живые люди,
// и прятать его значит прятать причину.
func TestBuildFunnel_KeepsStepForRemovedQuestion(t *testing.T) {
	questions := QuestionOrder([]VersionedSchema{
		vsg(1, grp("Имя", Block{ID: "b1", Type: BlockShortText}), grp("Паспорт", Block{ID: "old", Type: BlockShortText})),
		vsg(2, grp("Имя", Block{ID: "b1", Type: BlockShortText})),
	})
	f := BuildFunnel(questions, []LastBlockCount{{BlockID: "old", Visits: 9}})

	if len(f.Steps) != 2 || f.Steps[1].BlockID != "old" {
		t.Fatalf("шаги = %+v, ждали сохранённый вопрос old", f.Steps)
	}
	if f.Steps[1].DroppedHere != 9 {
		t.Errorf("DroppedHere удалённого вопроса = %d, ждали 9", f.Steps[1].DroppedHere)
	}
}

// Форму открывали, но ни одного визита не записалось (все ушли до бикона ухода):
// воронка не падает и не делит на ноль.
func TestBuildFunnel_NoCounts(t *testing.T) {
	f := BuildFunnel(threeQuestions(), nil)

	if len(f.Steps) != 3 {
		t.Fatalf("шагов = %d, ждали 3 (вопросы известны и без визитов)", len(f.Steps))
	}
	for i, s := range f.Steps {
		if s.Reached != 0 || s.DroppedHere != 0 {
			t.Errorf("шаг %d не нулевой: %+v", i, s)
		}
	}
}

// У формы без вопросов (все удалены после сбора) воронка пуста, но счётчики верхнего
// уровня остаются — экран покажет их, а не пустоту.
func TestBuildFunnel_NoQuestions(t *testing.T) {
	f := BuildFunnel(nil, []LastBlockCount{{BlockID: "", Visits: 4}})

	if len(f.Steps) != 0 {
		t.Fatalf("шагов = %d, ждали 0", len(f.Steps))
	}
	if f.Visits != 4 || f.LeftBeforeFirst != 4 {
		t.Errorf("счётчики верхнего уровня потеряны: %+v", f)
	}
}
