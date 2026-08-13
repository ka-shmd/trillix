package auth

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
)

func TestUpdateProfile_TrimsAndStores(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)
	id := domain.NewID()

	if _, err := svc.UpdateProfile(context.Background(), id, "  Иван  ", "Петров"); err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if !store.profileUpdated || store.profileUser != id {
		t.Fatalf("репозиторий не получил обновление (updated=%v user=%v)", store.profileUpdated, store.profileUser)
	}
	if store.profileFirstName == nil || *store.profileFirstName != "Иван" {
		t.Errorf("имя = %v, ожидалось «Иван» без окружающих пробелов", store.profileFirstName)
	}
}

func TestUpdateProfile_EmptyMeansNull(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)

	// Пустая строка и строка из пробелов — «стереть», то есть NULL. Второго
	// способа записать «не указано» быть не должно: пустая строка в колонке
	// разъедется с NULL в первом же запросе, который сравнивает с одним из них.
	if _, err := svc.UpdateProfile(context.Background(), domain.NewID(), "", "   "); err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if store.profileFirstName != nil || store.profileLastName != nil {
		t.Errorf("в репозиторий уехало имя=%v фамилия=%v, ожидались оба nil", store.profileFirstName, store.profileLastName)
	}
}

func TestUpdateProfile_RejectsTooLong(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)

	// Кириллица: лимит считается в рунах, а не в байтах — 101 буква «я» весит
	// 202 байта, и байтовая проверка отвергла бы уже 51 символ.
	_, err := svc.UpdateProfile(context.Background(), domain.NewID(), strings.Repeat("я", MaxPersonNameLen+1), "")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.profileUpdated {
		t.Error("репозиторий не должен вызываться при провале валидации")
	}
}

func TestUpdateProfile_AcceptsExactlyMaxLen(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)

	// Граница включительная: ровно MaxPersonNameLen рун проходят. Без этого
	// теста «> » легко превращается в «>=» при правке и молча отрезает символ.
	name := strings.Repeat("я", MaxPersonNameLen)
	if _, err := svc.UpdateProfile(context.Background(), domain.NewID(), name, ""); err != nil {
		t.Fatalf("имя ровно в %d рун отвергнуто: %v", MaxPersonNameLen, err)
	}
	if store.profileFirstName == nil || *store.profileFirstName != name {
		t.Error("имя длиной ровно в лимит не доехало до репозитория")
	}
}
