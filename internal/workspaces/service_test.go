package workspaces

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/postgres"
)

// fakeStore — герметичная подмена репозитория (без БД, инвариант тестов).
type fakeStore struct {
	workspaces []Workspace
	err        error
	gotUserID  uuid.UUID
}

func (f *fakeStore) ListByUser(_ context.Context, _ postgres.DBTX, userID uuid.UUID) ([]Workspace, error) {
	f.gotUserID = userID
	return f.workspaces, f.err
}

// ListForUser пробрасывает userID в репозиторий и возвращает его результат.
func TestListForUser_DelegatesAndReturns(t *testing.T) {
	uid := uuid.New()
	store := &fakeStore{workspaces: []Workspace{{ID: uuid.New(), Name: "Personal"}}}
	svc := NewService(nil, store)

	got, err := svc.ListForUser(context.Background(), uid)
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if store.gotUserID != uid {
		t.Fatalf("userID в репозиторий = %s, ожидался %s", store.gotUserID, uid)
	}
	if len(got) != 1 || got[0].Name != "Personal" {
		t.Fatalf("результат = %+v, ожидался один воркспейс Personal", got)
	}
}

// Ошибка репозитория пробрасывается наверх без проглатывания.
func TestListForUser_PropagatesError(t *testing.T) {
	wantErr := errors.New("db down")
	svc := NewService(nil, &fakeStore{err: wantErr})
	if _, err := svc.ListForUser(context.Background(), uuid.New()); !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, ожидался %v", err, wantErr)
	}
}
