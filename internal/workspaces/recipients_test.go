package workspaces

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Recipients — обратная сторона матрицы прав: не «можно ли ему», а «кому можно».
// Проверяется то же, что у Can, но с другой стороны — что состав адресатов
// повода определяет ДЕЙСТВИЕ, а не роль вызывающего и не порядок строк.
func TestRecipients_ByAction(t *testing.T) {
	owner, editor := uuid.New(), uuid.New()
	store := &fakeStore{members: []Member{
		{UserID: owner, Role: RoleOwner},
		{UserID: editor, Role: RoleEditor},
	}}
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example")

	cases := []struct {
		action domain.Action
		want   []uuid.UUID
	}{
		// Формы видят оба — повод о новых ответах и о сломанной интеграции
		// адресуется всей команде.
		{domain.ActionFormRead, []uuid.UUID{owner, editor}},
		// Тариф — дело владельца, и повод о превышении квоты редактору не
		// адресуется вовсе: он на него всё равно не ответит.
		{domain.ActionBillingView, []uuid.UUID{owner}},
		{domain.ActionMemberManage, []uuid.UUID{owner}},
	}
	for _, c := range cases {
		got, err := svc.Recipients(context.Background(), uuid.New(), c.action)
		if err != nil {
			t.Fatalf("%s: %v", c.action, err)
		}
		if len(got) != len(c.want) {
			t.Fatalf("%s: адресатов %d, ожидалось %d", c.action, len(got), len(c.want))
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: адресат %d = %s, ожидался %s", c.action, i, got[i], c.want[i])
			}
		}
	}
}

// Дыра в матрице (роль молчит про действие) — внутренняя ошибка, а не пустой
// список: молчание спрятало бы поломку конфигурации за «уведомление никому не
// пришло».
func TestRecipients_UnknownActionIsError(t *testing.T) {
	store := &fakeStore{members: []Member{{UserID: uuid.New(), Role: RoleOwner}}}
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example")

	if _, err := svc.Recipients(context.Background(), uuid.New(), domain.Action("form.teleport")); err == nil {
		t.Fatal("ожидалась ошибка про действие, которого нет в матрице")
	}
}

func TestRecipients_StoreError(t *testing.T) {
	store := &fakeStore{listMembersErr: errors.New("боль")}
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example")

	if _, err := svc.Recipients(context.Background(), uuid.New(), domain.ActionFormRead); err == nil {
		t.Fatal("ошибка состава обязана дойти до вызывающего")
	}
}
