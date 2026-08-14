//go:build integration

package auth_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Удаление аккаунта против настоящей БД (фаза 23, слайс G). Юниты сервиса видят
// намерение; здесь проверяется то, что живёт в запросах: слепота чтений к
// пометке, занятость освободившегося на вид адреса и отказ владельцу непустой
// команды — оба его исхода.

// deletedAt читает пометку удаления по email.
func deletedAt(t *testing.T, email string) *string {
	t.Helper()
	var at *string
	err := testPool.QueryRow(context.Background(),
		`SELECT deleted_at::text FROM users WHERE email = $1`, email).Scan(&at)
	if err != nil {
		t.Fatalf("select deleted_at %s: %v", email, err)
	}
	return at
}

// registerUser заводит аккаунт и возвращает клиента с его сессией.
func registerUser(t *testing.T, srv, email, password string) *http.Client {
	t.Helper()
	c := newClient(t)
	resp := post(t, c, srv+"/api/v1/auth/register", `{"email":"`+email+`","password":"`+password+`"}`, "")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: статус %d, ожидалось 201; тело=%s", email, resp.StatusCode, body(t, resp))
	}
	return c
}

// userID достаёт идентификатор аккаунта по адресу (нужен прямым вставкам
// командного пространства: заводить его через кабинет ради гейта незачем).
func userID(t *testing.T, email string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := testPool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatalf("select id %s: %v", email, err)
	}
	return id
}

// addTeam заводит КОМАНДНОЕ пространство (personal_user_id IS NULL) с
// владельцем и, если задан, вторым участником.
func addTeam(t *testing.T, name string, owner uuid.UUID, members ...uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	wsID := domain.NewID()
	if _, err := testPool.Exec(ctx, `INSERT INTO workspaces (id, name) VALUES ($1, $2)`, wsID, name); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, wsID, owner); err != nil {
		t.Fatalf("insert owner: %v", err)
	}
	for _, m := range members {
		if _, err := testPool.Exec(ctx,
			`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`, wsID, m); err != nil {
			t.Fatalf("insert member: %v", err)
		}
	}
	return wsID
}

// Шестой пункт критерия приёмки фазы (design/account-settings.md §1) на уровне
// API: после удаления вход не работает, живая сессия мертва, пометка стоит.
func TestAccountDelete_LocksOutAndMarks(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	const email = "leaving@example.com"
	const password = "supersecret1"
	c := registerUser(t, srv.URL, email, password)

	del := post(t, c, srv.URL+"/api/v1/account/delete",
		`{"currentPassword":"`+password+`"}`, csrfHeader(t, c, srv.URL))
	if del.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: статус %d, ожидалось 204; тело=%s", del.StatusCode, body(t, del))
	}

	if at := deletedAt(t, email); at == nil {
		t.Fatal("deleted_at пуст — аккаунт не помечен удалённым")
	}
	// Та же сессия, из которой удаляли: сессий у аккаунта не осталось ни одной.
	if me := get(t, c, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me после удаления: статус %d, ожидалось 401", me.StatusCode)
	}
	// Вход отвечает ОБЫЧНЫМ отказом: существование аккаунта наружу не
	// раскрывается (то же правило, что у forgot-password).
	login := post(t, newClient(t), srv.URL+"/api/v1/auth/login",
		`{"email":"`+email+`","password":"`+password+`"}`, "")
	if login.StatusCode != http.StatusUnauthorized {
		t.Fatalf("login после удаления: статус %d, ожидалось 401; тело=%s", login.StatusCode, body(t, login))
	}
	if code := decodeErrorCode(t, login); code != "invalid_credentials" {
		t.Fatalf("код ошибки входа = %q, ожидался invalid_credentials", code)
	}
}

// Адрес остаётся занятым: пометка не освобождает email (UNIQUE на месте), и
// перерегистрация на него невозможна до реальной чистки по 152-ФЗ.
func TestAccountDelete_EmailStaysTaken(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	const email = "gone@example.com"
	c := registerUser(t, srv.URL, email, "supersecret1")

	if del := post(t, c, srv.URL+"/api/v1/account/delete",
		`{"currentPassword":"supersecret1"}`, csrfHeader(t, c, srv.URL)); del.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: статус %d, ожидалось 204", del.StatusCode)
	}

	again := post(t, newClient(t), srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"supersecret1"}`, "")
	if again.StatusCode != http.StatusConflict {
		t.Fatalf("повторная регистрация: статус %d, ожидалось 409; тело=%s", again.StatusCode, body(t, again))
	}
}

// Смена адреса на занятый УДАЛЁННЫМ аккаунтом отвечает 409, а не падает на
// UNIQUE: занятость спрашивается отдельным запросом, слепым к пометке.
func TestAccountDelete_EmailChangeToDeletedAddressRejected(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	const gone = "vanished@example.com"
	goneClient := registerUser(t, srv.URL, gone, "supersecret1")
	if del := post(t, goneClient, srv.URL+"/api/v1/account/delete",
		`{"currentPassword":"supersecret1"}`, csrfHeader(t, goneClient, srv.URL)); del.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: статус %d, ожидалось 204", del.StatusCode)
	}

	c := registerUser(t, srv.URL, "living@example.com", "supersecret1")
	resp := post(t, c, srv.URL+"/api/v1/account/email",
		`{"newEmail":"`+gone+`","currentPassword":"supersecret1"}`, csrfHeader(t, c, srv.URL))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("смена адреса на занятый удалённым: статус %d, ожидалось 409; тело=%s", resp.StatusCode, body(t, resp))
	}
}

// Первый исход гейта: владелец команды С УЧАСТНИКАМИ не удаляется (TD-53).
func TestAccountDelete_OwnerOfTeamWithMembersRefused(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	const email = "owner@example.com"
	c := registerUser(t, srv.URL, email, "supersecret1")
	registerUser(t, srv.URL, "mate@example.com", "supersecret1")
	addTeam(t, "Отдел маркетинга", userID(t, email), userID(t, "mate@example.com"))

	resp := post(t, c, srv.URL+"/api/v1/account/delete",
		`{"currentPassword":"supersecret1"}`, csrfHeader(t, c, srv.URL))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("удаление владельца непустой команды: статус %d, ожидалось 409; тело=%s", resp.StatusCode, body(t, resp))
	}
	if at := deletedAt(t, email); at != nil {
		t.Fatal("аккаунт помечен удалённым вопреки отказу")
	}
	// Сессия при отказе жива: человек остаётся в кабинете и идёт передавать
	// владение, а не выясняет, почему его разлогинило.
	if me := get(t, c, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusOK {
		t.Fatalf("me после отказа: статус %d, ожидалось 200", me.StatusCode)
	}
}

// Второй исход: команда БЕЗ других участников удалению не мешает — сиротеть
// некому. Личное пространство тоже не мешает, оно есть у каждого аккаунта.
func TestAccountDelete_OwnerOfEmptyTeamAllowed(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	const email = "solo@example.com"
	c := registerUser(t, srv.URL, email, "supersecret1")
	addTeam(t, "Мои проекты", userID(t, email))

	resp := post(t, c, srv.URL+"/api/v1/account/delete",
		`{"currentPassword":"supersecret1"}`, csrfHeader(t, c, srv.URL))
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление владельца пустой команды: статус %d, ожидалось 204; тело=%s", resp.StatusCode, body(t, resp))
	}
	if at := deletedAt(t, email); at == nil {
		t.Fatal("deleted_at пуст — аккаунт не помечен удалённым")
	}
}

// Неверный пароль удаления не даёт, и это проверяется против настоящего хеша.
func TestAccountDelete_WrongPasswordKeepsAccount(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	const email = "careful@example.com"
	c := registerUser(t, srv.URL, email, "supersecret1")

	resp := post(t, c, srv.URL+"/api/v1/account/delete",
		`{"currentPassword":"not-my-password"}`, csrfHeader(t, c, srv.URL))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("статус %d, ожидалось 401", resp.StatusCode)
	}
	if at := deletedAt(t, email); at != nil {
		t.Fatal("аккаунт помечен удалённым при неверном пароле")
	}
	if me := get(t, c, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusOK {
		t.Fatalf("me после неудачной попытки: статус %d, ожидалось 200", me.StatusCode)
	}
}
