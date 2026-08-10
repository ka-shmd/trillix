//go:build integration

// Интеграционный тест сводки против настоящего Postgres: опубликованная форма со
// всеми видами агрегата (распределение, числа, доля заполнивших) → ответы → GET
// сводки. Проверяет демо-критерий фазы 8.5 шага 3 «сводка агрегируется сервером» и
// анти-IDOR (чужой → 404).
package submissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

const summarySchemaV1 = `{"blocks":[
	{"id":"b_intro","type":"text","label":"Здравствуйте","description":"","required":false,"settings":{}},
	{"id":"b_src","type":"single_choice","label":"Источник","description":"","required":false,"settings":{"options":[{"id":"o1","label":"Друзья"},{"id":"o2","label":"Поиск"}]}},
	{"id":"b_rate","type":"scale","label":"Оценка","description":"","required":false,"settings":{"scaleMin":1,"scaleMax":5}},
	{"id":"b_ok","type":"consent","label":"Согласен на рассылку","description":"","required":false,"settings":{}},
	{"id":"b_age","type":"number","label":"Возраст","description":"","required":false,"settings":{}},
	{"id":"b_note","type":"long_text","label":"Комментарий","description":"","required":false,"settings":{}}
]}`

// DTO ответа сводки — зеркалит summaryResponse транспорта (тест ходит через HTTP,
// внутренние типы ему недоступны: пакет submissions_test).
type summaryBody struct {
	Total  int `json:"total"`
	Blocks []struct {
		BlockID  string `json:"blockId"`
		Label    string `json:"label"`
		Type     string `json:"type"`
		Kind     string `json:"kind"`
		Asked    int    `json:"asked"`
		Answered int    `json:"answered"`
		Buckets  []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
			Count int    `json:"count"`
		} `json:"buckets"`
		Number *struct {
			Avg float64 `json:"avg"`
			Min float64 `json:"min"`
			Max float64 `json:"max"`
		} `json:"number"`
	} `json:"blocks"`
}

func (s summaryBody) block(t *testing.T, id string) (int, map[string]int) {
	t.Helper()
	for _, b := range s.Blocks {
		if b.BlockID == id {
			m := make(map[string]int, len(b.Buckets))
			for _, bk := range b.Buckets {
				m[bk.Label] = bk.Count
			}
			return b.Answered, m
		}
	}
	t.Fatalf("вопрос %q отсутствует в сводке", id)
	return 0, nil
}

// publishSummaryForm создаёт форму под userID и публикует одну версию.
func publishSummaryForm(t *testing.T, userID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	form, err := formsSvc.Create(ctx, userID, "Сводка", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, form.ID, []byte(summarySchemaV1), form.UpdatedAt); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, userID, form.ID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return form.ID
}

func TestSummary_AggregatesOnServer(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)
	v1 := versionID(t, formID, 1)

	insertAnswer(t, formID, v1, `{"b_src":"o1","b_rate":"5","b_ok":"yes","b_age":"30","b_note":"хорошо"}`)
	insertAnswer(t, formID, v1, `{"b_src":"o1","b_rate":"3","b_ok":"","b_age":"20"}`)
	insertAnswer(t, formID, v1, `{"b_rate":"5","b_age":"40"}`)

	resp, err := owner.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/summary")
	if err != nil {
		t.Fatalf("get summary: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", resp.StatusCode)
	}

	var body summaryBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Total != 3 {
		t.Fatalf("всего ответов = %d, ожидалось 3", body.Total)
	}
	// Неотвечаемый блок (text) в сводку не попадает — как и в CSV.
	for _, b := range body.Blocks {
		if b.BlockID == "b_intro" {
			t.Fatal("контентный блок попал в сводку")
		}
	}

	// Одиночный выбор: подписи вместо id, невыбранный вариант с нулём.
	srcAnswered, src := body.block(t, "b_src")
	if src["Друзья"] != 2 || src["Поиск"] != 0 || srcAnswered != 2 {
		t.Errorf("источник: распределение = %v, ответивших = %d; ожидалось Друзья:2 Поиск:0, ответивших 2",
			src, srcAnswered)
	}
	// Шкала: все деления диапазона, включая нулевые.
	_, rate := body.block(t, "b_rate")
	if rate["5"] != 2 || rate["3"] != 1 || len(rate) != 5 {
		t.Errorf("шкала: распределение = %v, ожидалось 5:2 3:1 при пяти делениях", rate)
	}
	// Согласие: «Нет» — и снявший галочку, и не тронувший вопрос.
	_, ok := body.block(t, "b_ok")
	if ok["Да"] != 1 || ok["Нет"] != 2 {
		t.Errorf("согласие: распределение = %v, ожидалось Да:1 Нет:2", ok)
	}
	// Доля заполнивших: комментарий оставил один из трёх.
	noteAnswered, _ := body.block(t, "b_note")
	if noteAnswered != 1 {
		t.Errorf("комментарий: ответивших = %d, ожидалось 1", noteAnswered)
	}

	// Числа: среднее/мин/макс.
	var age *struct {
		Avg float64 `json:"avg"`
		Min float64 `json:"min"`
		Max float64 `json:"max"`
	}
	for _, b := range body.Blocks {
		if b.BlockID == "b_age" {
			if b.Kind != "number" {
				t.Fatalf("возраст: вид сводки = %q, ожидались числа", b.Kind)
			}
			age = b.Number
		}
	}
	if age == nil {
		t.Fatal("возраст: статистика не пришла")
	}
	if age.Avg != 30 || age.Min != 20 || age.Max != 40 {
		t.Errorf("возраст: среднее/мин/макс = %v, ожидалось 30/20/40", *age)
	}
}

// Сводка чужой формы — 404, как и всё приватное (id формы из URL правом доступа не
// является, инвариант 1).
func TestSummary_ForeignForm_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	_, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)

	attacker, _ := authedClient(t, srv, "attacker-"+uuid.NewString()[:8]+"@example.com")
	resp, err := attacker.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/summary")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая сводка: статус %d, ожидалось 404", resp.StatusCode)
	}
}

// Сводка формы без опубликованных версий (только черновик) — 200 с пустым итогом, а
// не 404/500: страница обязана открыться и сказать «ответов пока нет».
func TestSummary_NoVersions_EmptyButValid(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	form, err := formsSvc.Create(context.Background(), ownerID, "черновик", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	resp, err := owner.Get(srv.URL + "/api/v1/forms/" + form.ID.String() + "/submissions/summary")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", resp.StatusCode)
	}
	var body summaryBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Total != 0 || len(body.Blocks) != 0 {
		t.Fatalf("сводка черновика = %+v, ожидался пустой итог", body)
	}
}
