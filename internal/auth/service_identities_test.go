package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Гейт «останется ли способ войти» (фаза 23, слайс E). Правило одно: аккаунт без
// пароля не может остаться без единственной привязки — иначе данные внутри
// становятся недостижимы, и починить это можно только руками в БД.

func TestUnlinkIdentity_LastWayInRefused(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "yandex@example.com", PasswordHash: nil}
	store := &fakeStore{identities: []Identity{{Provider: "yandex"}}}
	svc := newService(store)

	err := svc.UnlinkIdentity(context.Background(), user, "yandex")
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ошибка = %v, ожидалась ErrConflict", err)
	}
	if store.deletedIdentity != "" {
		t.Fatal("привязка удалена, хотя войти после этого было бы нечем")
	}
}

func TestUnlinkIdentity_AllowedWhenPasswordExists(t *testing.T) {
	hash := "argon2id-hash"
	user := User{ID: domain.NewID(), Email: "user@example.com", PasswordHash: &hash}
	store := &fakeStore{identities: []Identity{{Provider: "yandex"}}}
	svc := newService(store)

	// Пароль есть — единственная привязка отвязывается свободно.
	if err := svc.UnlinkIdentity(context.Background(), user, "yandex"); err != nil {
		t.Fatalf("UnlinkIdentity: %v", err)
	}
	if store.deletedIdentity != "yandex" {
		t.Fatalf("удалена привязка %q", store.deletedIdentity)
	}
}

func TestUnlinkIdentity_AllowedWhenSecondIdentityRemains(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "yandex@example.com", PasswordHash: nil}
	store := &fakeStore{identities: []Identity{{Provider: "yandex"}, {Provider: "vk"}}}
	svc := newService(store)

	// Пароля нет, но привязок две — одну можно снять, вход останется.
	if err := svc.UnlinkIdentity(context.Background(), user, "vk"); err != nil {
		t.Fatalf("UnlinkIdentity: %v", err)
	}
	if store.deletedIdentity != "vk" {
		t.Fatalf("удалена привязка %q", store.deletedIdentity)
	}
}

func TestLinkIdentity_AlreadyLinkedIsConflict(t *testing.T) {
	store := &fakeStore{createIdentityErr: &pgconn.PgError{Code: uniqueViolationCode}}
	svc := newService(store)

	// «Привязана к вам» и «привязана к другому» снаружи неразличимы: второй
	// ответ рассказывал бы спрашивающему о чужом аккаунте.
	err := svc.LinkIdentity(context.Background(), domain.NewID(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "1", Email: "a@ya.ru",
	})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ошибка = %v, ожидалась ErrConflict", err)
	}
}

func TestLinkIdentity_StoresProviderEmailNormalized(t *testing.T) {
	store := &fakeStore{}
	svc := newService(store)

	if err := svc.LinkIdentity(context.Background(), domain.NewID(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "1", Email: "  Ivan@Yandex.RU ",
	}); err != nil {
		t.Fatalf("LinkIdentity: %v", err)
	}
	// Адрес подписывает карточку — он должен лечь так же, как в users.email,
	// иначе один и тот же ящик выглядит по-разному в двух местах экрана.
	if store.identityEmail != "ivan@yandex.ru" {
		t.Fatalf("адрес у провайдера = %q, ожидался нормализованный", store.identityEmail)
	}
}
