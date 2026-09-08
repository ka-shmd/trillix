package auth

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// avatarBody собирает multipart-тело с одним полем file.
func avatarBody(t *testing.T, field string, data []byte) (string, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	w, err := mw.CreateFormFile(field, "avatar.png")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return mw.FormDataContentType(), &buf
}

func postAvatar(srv http.Handler, contentType string, body *bytes.Buffer, authed, csrf bool) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/account/avatar", body)
	req.Header.Set("Content-Type", contentType)
	if authed {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
		req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
		if csrf {
			req.Header.Set(csrfHeaderName, "tok")
		}
	}
	srv.ServeHTTP(rec, req)
	return rec
}

func TestUploadAvatar_ОтвечаетПолнымПрофилем(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	ct, body := avatarBody(t, "file", []byte("картинка"))
	rec := postAvatar(srv, ct, body, true, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200: %s", rec.Code, rec.Body.String())
	}
	// Кабинет патчит этим ответом кэш профиля целиком — урезанный объект стёр бы
	// в нём email и флаг второго фактора.
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("ответ не JSON: %v", err)
	}
	if got["avatarKey"] != "avatars/deadbeef.png" {
		t.Fatalf("avatarKey = %v", got["avatarKey"])
	}
	if got["email"] != "a@b.com" {
		t.Fatalf("ответ не полный профиль: %v", got)
	}
	if string(svc.avatarBytes) != "картинка" {
		t.Fatalf("до сервиса доехало %q", svc.avatarBytes)
	}
}

// Пользователь берётся из сессии, а не из тела: подмешанный userId ничего не
// меняет (то же правило, что у правки имени).
func TestUploadAvatar_ЛичностьИзСессии(t *testing.T) {
	owner := domain.NewID()
	svc := &fakeAuthService{user: User{ID: owner, Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	ct, body := avatarBody(t, "file", []byte("картинка"))
	if rec := postAvatar(srv, ct, body, true, true); rec.Code != http.StatusOK {
		t.Fatalf("статус = %d", rec.Code)
	}
	if svc.avatarUser != owner {
		t.Fatalf("сервис получил %s, ожидался %s", svc.avatarUser, owner)
	}
}

func TestUploadAvatar_RequiresAuth(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestAccountHandler(svc)

	ct, body := avatarBody(t, "file", []byte("картинка"))
	rec := postAvatar(srv, ct, body, false, false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	if svc.avatarBytes != nil {
		t.Error("сервис не должен вызываться без сессии")
	}
}

func TestUploadAvatar_RequiresCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	ct, body := avatarBody(t, "file", []byte("картинка"))
	rec := postAvatar(srv, ct, body, true, false)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("без CSRF-заголовка статус = %d, ожидалось 403", rec.Code)
	}
	if svc.avatarBytes != nil {
		t.Error("сервис не должен вызываться при провале CSRF")
	}
}

// Поле не file (или не multipart вовсе) — 422, а не паника на nil-файле.
func TestUploadAvatar_ЧужоеПолеОтвергается(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	ct, body := avatarBody(t, "picture", []byte("картинка"))
	rec := postAvatar(srv, ct, body, true, true)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422", rec.Code)
	}
	if svc.avatarBytes != nil {
		t.Error("сервис не должен вызываться без поля file")
	}
}

// MaxBytesReader на месте: тело больше потолка не доезжает до декодера картинки.
func TestUploadAvatar_ОтвергаетБольшоеТело(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	ct, body := avatarBody(t, "file", bytes.Repeat([]byte("x"), maxAvatarBytes+1))
	rec := postAvatar(srv, ct, body, true, true)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("статус = %d, ожидалось 413", rec.Code)
	}
	if svc.avatarBytes != nil {
		t.Error("сервис не должен вызываться при превышении лимита тела")
	}
}

func TestUploadAvatar_RateLimitedPerUser(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false).
		WithAccount(AccountLimits{PasswordChange: ratelimit.AllowAll{}, TwoFactor: ratelimit.AllowAll{}, DeleteAccount: ratelimit.AllowAll{}, Avatar: denyLimiter{}})
	mux := http.NewServeMux()
	h.AccountRoutes(mux)

	// Ведро по пользователю: щит не от подбора (сессия своя), а от стоимости
	// декода и ре-энкода картинки.
	ct, body := avatarBody(t, "file", []byte("картинка"))
	rec := postAvatar(mux, ct, body, true, true)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
	if svc.avatarBytes != nil {
		t.Error("сервис не должен вызываться при срабатывании лимита")
	}
}

func deleteAvatarReq(srv http.Handler, authed, csrf bool) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/account/avatar", strings.NewReader(""))
	if authed {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
		req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
		if csrf {
			req.Header.Set(csrfHeaderName, "tok")
		}
	}
	srv.ServeHTTP(rec, req)
	return rec
}

func TestDeleteAvatar_СниметИОтветитПрофилем(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	rec := deleteAvatarReq(srv, true, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200: %s", rec.Code, rec.Body.String())
	}
	if !svc.avatarCleared {
		t.Error("сервис не вызван")
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("ответ не JSON: %v", err)
	}
	if got["avatarKey"] != "" {
		t.Fatalf("avatarKey = %v, ожидалась пустая строка", got["avatarKey"])
	}
}

func TestDeleteAvatar_RequiresAuthAndCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	if rec := deleteAvatarReq(srv, false, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("без сессии статус = %d, ожидалось 401", rec.Code)
	}
	if rec := deleteAvatarReq(srv, true, false); rec.Code != http.StatusForbidden {
		t.Fatalf("без CSRF-заголовка статус = %d, ожидалось 403", rec.Code)
	}
	if svc.avatarCleared {
		t.Error("сервис не должен вызываться при провале авторизации или CSRF")
	}
}
