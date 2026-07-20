//go:build integration

// Интеграционный тест CSV-экспорта против настоящего Postgres: две опубликованные
// версии формы, ответы по обеим → экспорт → парсинг CSV. Проверяет демо-критерий
// фазы 6: читаемая кириллица (BOM), подписи опций вместо id, колонка выбывшего в v2
// вопроса живёт для ответов v1, и анти-IDOR (чужой → 404).
package submissions_test

import (
	"bytes"
	"context"
	"encoding/csv"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const (
	exportSchemaV1 = `{"blocks":[
		{"id":"b_name","type":"short_text","label":"Имя","description":"","required":true,"settings":{}},
		{"id":"b_src","type":"single_choice","label":"Источник","description":"","required":false,"settings":{"options":[{"id":"o1","label":"Друзья"},{"id":"o2","label":"Поиск"}]}},
		{"id":"b_phone","type":"short_text","label":"Телефон","description":"","required":false,"settings":{}}
	]}`
	exportSchemaV2 = `{"blocks":[
		{"id":"b_name","type":"short_text","label":"Имя","description":"","required":true,"settings":{}},
		{"id":"b_src","type":"single_choice","label":"Источник","description":"","required":false,"settings":{"options":[{"id":"o1","label":"Друзья (реф.)"},{"id":"o2","label":"Поиск"}]}},
		{"id":"b_city","type":"short_text","label":"Город","description":"","required":false,"settings":{}}
	]}`
)

// publishTwoVersions создаёт форму под userID, публикует v1 и v2; возвращает id формы.
func publishTwoVersions(t *testing.T, userID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	form, err := formsSvc.Create(ctx, userID, "CSV")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, form.ID, []byte(exportSchemaV1), form.UpdatedAt); err != nil {
		t.Fatalf("v1 schema: %v", err)
	}
	pub1, err := formsSvc.Publish(ctx, userID, form.ID)
	if err != nil {
		t.Fatalf("publish v1: %v", err)
	}
	// Publish двигает updated_at — для оптимистичной блокировки следующего сейва
	// берём значение из результата публикации, а не из сейва v1.
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, form.ID, []byte(exportSchemaV2), pub1.UpdatedAt); err != nil {
		t.Fatalf("v2 schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, userID, form.ID); err != nil {
		t.Fatalf("publish v2: %v", err)
	}
	return form.ID
}

// insertAnswer кладёт один ответ напрямую (минуя антиспам) по указанной версии.
func insertAnswer(t *testing.T, formID, versionID uuid.UUID, answersJSON string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO submissions (id, form_id, form_version_id, answers) VALUES ($1,$2,$3,$4)`,
		domain.NewID(), formID, versionID, answersJSON)
	if err != nil {
		t.Fatalf("insert answer: %v", err)
	}
}

func versionID(t *testing.T, formID uuid.UUID, version int) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := testPool.QueryRow(context.Background(),
		`SELECT id FROM form_versions WHERE form_id=$1 AND version=$2`, formID, version).Scan(&id); err != nil {
		t.Fatalf("version id: %v", err)
	}
	return id
}

func TestExportCSV_TwoVersions(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishTwoVersions(t, ownerID)
	v1, v2 := versionID(t, formID, 1), versionID(t, formID, 2)

	// Ответ v1: выбрал o1 («Друзья»), заполнил телефон. Ответ v2: o1 переименован в
	// «Друзья (реф.)», указан город.
	insertAnswer(t, formID, v1, `{"b_name":"Анна","b_src":"o1","b_phone":"+79001112233"}`)
	insertAnswer(t, formID, v2, `{"b_name":"Борис","b_src":"o1","b_city":"Пермь"}`)

	resp, err := owner.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/export")
	if err != nil {
		t.Fatalf("get export: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/csv") {
		t.Fatalf("Content-Type = %q, ожидался text/csv", ct)
	}

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	raw := buf.Bytes()
	// BOM в начале — Excel читает кириллицу.
	if !bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatalf("нет UTF-8 BOM в начале файла")
	}

	rows, err := csv.NewReader(bytes.NewReader(raw[3:])).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(rows) != 3 { // заголовок + 2 ответа
		t.Fatalf("строк CSV = %d, ожидалось 3 (заголовок + 2)", len(rows))
	}

	// Заголовок: мета + свежая версия слева (b_name, b_src, b_city), затем выбывший b_phone.
	header := rows[0]
	wantHeader := []string{"ID ответа", "Отправлен", "Версия формы", "Имя", "Источник", "Город", "Телефон"}
	if strings.Join(header, "|") != strings.Join(wantHeader, "|") {
		t.Fatalf("заголовок = %v, ожидался %v", header, wantHeader)
	}

	// Найдём строки ответов по имени (порядок — новые сверху, но не завязываемся).
	byName := map[string][]string{}
	for _, r := range rows[1:] {
		byName[r[3]] = r // r[3] = колонка «Имя»
	}
	anna, boris := byName["Анна"], byName["Борис"]
	if anna == nil || boris == nil {
		t.Fatalf("не нашли обе строки ответов: %v", byName)
	}
	// col: 3 Имя, 4 Источник, 5 Город, 6 Телефон
	if anna[4] != "Друзья" { // подпись из версии ответа (v1), не свежая
		t.Errorf("Анна.Источник = %q, ожидалось «Друзья»", anna[4])
	}
	if anna[5] != "" { // города в v1 нет
		t.Errorf("Анна.Город = %q, ожидалась пустая ячейка", anna[5])
	}
	// Телефон начинается с + → защита от CSV formula injection префиксует его
	// апострофом. Заодно end-to-end проверка, что санитизация доходит через
	// реальный csv.Writer, а не только в юните билдера (TD-3).
	if anna[6] != "'+79001112233" {
		t.Errorf("Анна.Телефон = %q, ожидался с префиксом ' (санитизация)", anna[6])
	}
	if boris[4] != "Друзья (реф.)" { // подпись из v2
		t.Errorf("Борис.Источник = %q, ожидалось «Друзья (реф.)»", boris[4])
	}
	if boris[5] != "Пермь" {
		t.Errorf("Борис.Город = %q, ожидалось «Пермь»", boris[5])
	}
	if boris[6] != "" { // телефона в v2 нет
		t.Errorf("Борис.Телефон = %q, ожидалась пустая ячейка", boris[6])
	}
}

func TestExportCSV_ForeignForm_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	_, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishTwoVersions(t, ownerID)

	attacker, _ := authedClient(t, srv, "attacker-"+uuid.NewString()[:8]+"@example.com")
	resp, err := attacker.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/export")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("чужой экспорт: статус %d, ожидалось 404", resp.StatusCode)
	}
}

// Экспорт формы без опубликованных версий (только черновик) — 200 с одним лишь
// заголовком мета-колонок (вопросов нет), тело валидно.
func TestExportCSV_NoVersions_EmptyButValid(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	ctx := context.Background()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	form, err := formsSvc.Create(ctx, ownerID, "черновик")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	resp, err := owner.Get(srv.URL + "/api/v1/forms/" + form.ID.String() + "/submissions/export")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", resp.StatusCode)
	}
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	rows, err := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(buf.Bytes(), []byte{0xEF, 0xBB, 0xBF}))).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(rows) != 1 || len(rows[0]) != 3 {
		t.Fatalf("ожидался только заголовок из 3 метаколонок, получено %v", rows)
	}
}
