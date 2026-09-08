//go:build integration

// Интеграционный тест сводки против настоящего Postgres: опубликованная форма со
// всеми видами агрегата (распределение, числа, доля заполнивших) → ответы → GET
// сводки. Проверяет демо-критерий фазы 8.5 шага 3 «сводка агрегируется сервером» и
// анти-IDOR (чужой → 404).
package submissions_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

const summarySchemaV1 = `{"blocks":[
	{"id":"b_intro","groupId":"g_b_intro","type":"text","text":[{"t":"Здравствуйте"}],"required":false,"settings":{}},
	{"id":"t_b_src","groupId":"g_b_src","type":"title","text":[{"t":"Источник"}]},{"id":"b_src","groupId":"g_b_src","type":"single_choice","required":false,"settings":{"options":[{"id":"o1","label":"Друзья"},{"id":"o2","label":"Поиск"}]}},
	{"id":"t_b_rate","groupId":"g_b_rate","type":"title","text":[{"t":"Оценка"}]},{"id":"b_rate","groupId":"g_b_rate","type":"scale","required":false,"settings":{"scaleMin":1,"scaleMax":5}},
	{"id":"b_ok","groupId":"g_b_ok","type":"consent","text":[{"t":"Согласен на рассылку"}],"required":false,"settings":{}},
	{"id":"t_b_age","groupId":"g_b_age","type":"title","text":[{"t":"Возраст"}]},{"id":"b_age","groupId":"g_b_age","type":"number","required":false,"settings":{}},
	{"id":"t_b_note","groupId":"g_b_note","type":"title","text":[{"t":"Комментарий"}]},{"id":"b_note","groupId":"g_b_note","type":"long_text","required":false,"settings":{}}
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
		Samples []struct {
			Text string `json:"text"`
			At   string `json:"at"`
		} `json:"samples"`
	} `json:"blocks"`
}

// samplesLimit зеркалит domain.SamplesLimit: тест ходит через HTTP и внутренние
// константы ему недоступны (пакет submissions_test). Разъедутся — тест упадёт на
// числе значений, а не промолчит.
const samplesLimit = 10

// blockByID достаёт вопрос сводки целиком — в отличие от block(), который отдаёт
// только распределение.
func (s summaryBody) blockByID(t *testing.T, id string) struct {
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
	Samples []struct {
		Text string `json:"text"`
		At   string `json:"at"`
	} `json:"samples"`
} {
	t.Helper()
	for _, b := range s.Blocks {
		if b.BlockID == id {
			return b
		}
	}
	t.Fatalf("в сводке нет вопроса %s", id)
	return s.Blocks[0]
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
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
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
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
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

// Последние ответы приезжают сквозь весь путь: приём → хранение → сводка. Юнитом
// не покрыть: между свёрткой и экраном лежат листинг пачками и порядок обхода
// (новые сверху), от которого зависит, какие десять значений считаются последними.
func TestSummary_SamplesEndToEnd(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "samples-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)
	v1 := versionID(t, formID, 1)

	const extra = 2
	for i := 1; i <= samplesLimit+extra; i++ {
		insertAnswer(t, formID, v1, fmt.Sprintf(`{"b_note":"Ответ %02d","b_src":"o1"}`, i))
	}

	resp, err := owner.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/summary")
	if err != nil {
		t.Fatalf("get summary: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var body summaryBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}

	note := body.blockByID(t, "b_note")
	if len(note.Samples) != samplesLimit {
		t.Fatalf("значений = %d, ждали потолок %d: остальное — через листинг ответов",
			len(note.Samples), samplesLimit)
	}
	// Новые сверху: последний отправленный ответ стоит первым.
	if want := fmt.Sprintf("Ответ %02d", samplesLimit+extra); note.Samples[0].Text != want {
		t.Errorf("первое значение = %q, ждали %q", note.Samples[0].Text, want)
	}
	if note.Samples[0].At == "" {
		t.Error("у значения нет времени — экрану нечего показать вместо «2 минуты назад»")
	}

	// У вопроса с вариантами значения тоже есть, и это ПОДПИСИ, а не внутренние id.
	src := body.blockByID(t, "b_src")
	if len(src.Samples) == 0 || src.Samples[0].Text != "Друзья" {
		t.Errorf("значения выбора = %+v, ждали подпись «Друзья»", src.Samples)
	}
}

// DTO окна «все ответы на вопрос» — зеркалит blockAnswersResponse транспорта.
type blockAnswersBody struct {
	Answers []struct {
		Text string `json:"text"`
		At   string `json:"at"`
	} `json:"answers"`
	NextCursor *string `json:"nextCursor"`
}

func getBlockAnswers(t *testing.T, c *http.Client, base string, formID uuid.UUID, block, query string) blockAnswersBody {
	t.Helper()
	resp, err := c.Get(base + "/api/v1/forms/" + formID.String() + "/submissions/summary/" + block + query)
	if err != nil {
		t.Fatalf("get block answers: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", resp.StatusCode)
	}
	var body blockAnswersBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body
}

// Окно «все ответы»: сводка отдаёт десять последних значений вопроса, окно листает
// их целиком. Проверяется то, ради чего ручка и заведена, — что за потолок сводки
// можно выйти, и что порядок остаётся «новые сверху» через границу страниц.
func TestBlockAnswers_PagesBeyondSummaryLimit(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)
	v1 := versionID(t, formID, 1)

	// Ответы вставляются по возрастанию: id — UUIDv7, и порядок вставки задаёт
	// хронологию, по которой листинг отдаёт «новые сверху».
	const total = samplesLimit + 5
	for i := 0; i < total; i++ {
		insertAnswer(t, formID, v1, fmt.Sprintf(`{"b_note":"ответ %02d"}`, i))
	}

	// Сводка упирается в свой потолок — ради этого окно и нужно.
	first := getBlockAnswers(t, owner, srv.URL, formID, "b_note", "?limit="+fmt.Sprint(samplesLimit))
	if len(first.Answers) != samplesLimit {
		t.Fatalf("на первой странице %d значений, ожидалось %d", len(first.Answers), samplesLimit)
	}
	if first.Answers[0].Text != fmt.Sprintf("ответ %02d", total-1) {
		t.Errorf("сверху %q, ожидался самый свежий ответ", first.Answers[0].Text)
	}
	if first.NextCursor == nil {
		t.Fatal("курсор пуст, хотя ответы не кончились")
	}

	second := getBlockAnswers(t, owner, srv.URL, formID, "b_note", "?cursor="+*first.NextCursor)
	if len(second.Answers) != total-samplesLimit {
		t.Fatalf("на второй странице %d значений, ожидалось %d", len(second.Answers), total-samplesLimit)
	}
	// Порядок сквозной: вторая страница продолжает первую, а не начинает заново.
	if second.Answers[0].Text != fmt.Sprintf("ответ %02d", total-samplesLimit-1) {
		t.Errorf("вторая страница начинается с %q — порядок разорван", second.Answers[0].Text)
	}
	// Ответы кончились: курсора больше нет, иначе окно листалось бы вечно.
	if second.NextCursor != nil {
		t.Errorf("курсор %q на последней странице", *second.NextCursor)
	}
}

// Значение приходит РЕНДЕРОМ, тем же, что в сводке: подпись опции, а не её id.
// Иначе окно, открытое из строки распределения, показало бы другой текст, чем
// строка над ним.
func TestBlockAnswers_RendersOptionLabels(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)
	v1 := versionID(t, formID, 1)

	insertAnswer(t, formID, v1, `{"b_src":"o1"}`)
	insertAnswer(t, formID, v1, `{"b_src":"o2"}`)

	body := getBlockAnswers(t, owner, srv.URL, formID, "b_src", "")
	if len(body.Answers) != 2 {
		t.Fatalf("значений %d, ожидалось 2", len(body.Answers))
	}
	if body.Answers[0].Text != "Поиск" || body.Answers[1].Text != "Друзья" {
		t.Errorf("значения %q и %q, ожидались подписи опций «Поиск» и «Друзья»",
			body.Answers[0].Text, body.Answers[1].Text)
	}
}

// Анти-IDOR: id формы в адресе правом доступа не является. Чужая форма — 404, а не
// 403: существование приватного не раскрывается.
func TestBlockAnswers_ForeignForm_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	_, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	stranger, _ := authedClient(t, srv, "stranger-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)

	resp, err := stranger.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/summary/b_note")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404", resp.StatusCode)
	}
}
