package notify

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

type fakeAccess struct {
	users        []uuid.UUID
	err          error
	gotWorkspace uuid.UUID
	gotAction    domain.Action
}

func (f *fakeAccess) Recipients(_ context.Context, workspaceID uuid.UUID, action domain.Action) ([]uuid.UUID, error) {
	f.gotWorkspace, f.gotAction = workspaceID, action
	return f.users, f.err
}

type clearCall struct {
	kind    string
	subject uuid.UUID
}

type fakeStore struct {
	inserted  []Insertion
	insertErr error
	cleared   []clearCall
	rows      []Stored
	listLimit int32
	listErr   error
	unread    int64

	markedIDs  []uuid.UUID
	markedAll  int
	deleted    []uuid.UUID
	deletedAll int

	purgeRead   time.Time
	purgeUnread time.Time
}

func (f *fakeStore) Insert(_ context.Context, _ postgres.DBTX, in Insertion) error {
	f.inserted = append(f.inserted, in)
	return f.insertErr
}

func (f *fakeStore) ClearUnread(_ context.Context, _ postgres.DBTX, kind string, subjectID uuid.UUID) (int64, error) {
	f.cleared = append(f.cleared, clearCall{kind, subjectID})
	return 1, nil
}

func (f *fakeStore) List(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID, limit int32) ([]Stored, error) {
	f.listLimit = limit
	if f.listErr != nil {
		return nil, f.listErr
	}
	if int32(len(f.rows)) > limit {
		return f.rows[:limit], nil
	}
	return f.rows, nil
}

func (f *fakeStore) CountUnread(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (int64, error) {
	return f.unread, nil
}

func (f *fakeStore) MarkRead(_ context.Context, _ postgres.DBTX, _ uuid.UUID, ids []uuid.UUID) (int64, error) {
	f.markedIDs = append(f.markedIDs, ids...)
	return int64(len(ids)), nil
}

func (f *fakeStore) MarkAllRead(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (int64, error) {
	f.markedAll++
	return 0, nil
}

func (f *fakeStore) Delete(_ context.Context, _ postgres.DBTX, _ uuid.UUID, id uuid.UUID) (int64, error) {
	f.deleted = append(f.deleted, id)
	return 1, nil
}

func (f *fakeStore) DeleteAll(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (int64, error) {
	f.deletedAll++
	return 2, nil
}

func (f *fakeStore) Purge(_ context.Context, _ postgres.DBTX, readBefore, unreadBefore time.Time) (int64, error) {
	f.purgeRead, f.purgeUnread = readBefore, unreadBefore
	return 3, nil
}

func newTestService(access *fakeAccess, store *fakeStore) *Service {
	return NewService(nil, store, access)
}

// Адресатов называет РЕЕСТР, а не вызывающий: повод о квоте адресуется тем, кому
// можно видеть тариф, а повод о новых ответах — тем, кому можно видеть формы.
// Перепутать их означало бы показать редактору счёт, а владельцу — ничего.
func TestNotify_AsksRecipientsByKindAction(t *testing.T) {
	ws := uuid.New()
	cases := []struct {
		kind Kind
		want domain.Action
	}{
		{KindNewSubmissions, domain.ActionFormRead},
		{KindIntegrationBroken, domain.ActionFormRead},
		{KindOverQuota, domain.ActionBillingView},
	}
	for _, c := range cases {
		access := &fakeAccess{users: []uuid.UUID{uuid.New()}}
		svc := newTestService(access, &fakeStore{})
		if err := svc.Notify(context.Background(), nil, Event{WorkspaceID: ws, Kind: c.kind, SubjectID: uuid.New()}); err != nil {
			t.Fatalf("%s: %v", c.kind, err)
		}
		if access.gotAction != c.want {
			t.Errorf("%s: спросили право %q, ожидалось %q", c.kind, access.gotAction, c.want)
		}
		if access.gotWorkspace != ws {
			t.Errorf("%s: спросили не про то пространство", c.kind)
		}
	}
}

// Строк ставится по одной на адресата, и id у каждой свой: общий id уронил бы
// вставку на первичном ключе, а нулевой сломал бы курсор ленты.
func TestNotify_OneRowPerRecipient(t *testing.T) {
	users := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{users: users}, store)

	form := uuid.New()
	err := svc.Notify(context.Background(), nil, Event{
		WorkspaceID: uuid.New(), Kind: KindNewSubmissions, FormID: form, SubjectID: form,
		Payload: Payload{FormTitle: "Заявка", FormSlug: "zayavka"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(store.inserted) != 1 {
		t.Fatalf("вставок %d, ожидалась одна на всех адресатов", len(store.inserted))
	}
	in := store.inserted[0]
	if len(in.IDs) != len(users) || len(in.Users) != len(users) {
		t.Fatalf("массивы длины %d/%d, адресатов %d", len(in.IDs), len(in.Users), len(users))
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range in.IDs {
		if id == uuid.Nil {
			t.Fatal("пустой id строки")
		}
		if seen[id] {
			t.Fatal("два адресата получили строку с одним id")
		}
		seen[id] = true
	}
	var p Payload
	if err := json.Unmarshal(in.Payload, &p); err != nil {
		t.Fatalf("снимок не разбирается: %v", err)
	}
	if p.FormTitle != "Заявка" || p.FormSlug != "zayavka" {
		t.Errorf("снимок уехал неполным: %+v", p)
	}
}

// Ноль адресатов — штатный исход (все ушли из пространства, право есть только у
// владельца, которого в списке нет), а не повод бить в БД пустым утверждением.
func TestNotify_NoRecipientsNoInsert(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{}, store)

	if err := svc.Notify(context.Background(), nil, Event{Kind: KindNewSubmissions, SubjectID: uuid.New()}); err != nil {
		t.Fatal(err)
	}
	if len(store.inserted) != 0 {
		t.Fatal("без адресатов вставки быть не должно")
	}
}

func TestNotify_UnknownKind(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{users: []uuid.UUID{uuid.New()}}, store)

	if err := svc.Notify(context.Background(), nil, Event{Kind: "telepathy", SubjectID: uuid.New()}); err == nil {
		t.Fatal("повод не из реестра обязан быть ошибкой")
	}
	if len(store.inserted) != 0 {
		t.Fatal("неизвестный повод не должен доезжать до БД")
	}
}

func TestNotify_RecipientsError(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{err: errors.New("боль")}, store)

	if err := svc.Notify(context.Background(), nil, Event{Kind: KindNewSubmissions, SubjectID: uuid.New()}); err == nil {
		t.Fatal("ошибка прав обязана дойти до вызывающего")
	}
}

// Отбой есть только у препятствия. Попытка «погасить» счётчик — ошибка
// вызывающего, а не тихий no-op: у новых ответов отбой один, и это прочтение.
func TestClear_ObstaclesOnly(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{}, store)
	target := uuid.New()

	if err := svc.Clear(context.Background(), nil, KindIntegrationBroken, target); err != nil {
		t.Fatalf("отбой препятствия: %v", err)
	}
	if len(store.cleared) != 1 || store.cleared[0].kind != string(KindIntegrationBroken) || store.cleared[0].subject != target {
		t.Fatalf("отбой ушёл не туда: %+v", store.cleared)
	}
	if err := svc.Clear(context.Background(), nil, KindNewSubmissions, target); err == nil {
		t.Fatal("у повода-счётчика отбоя нет — ожидалась ошибка")
	}
	if err := svc.Clear(context.Background(), nil, "telepathy", target); err == nil {
		t.Fatal("повод не из реестра обязан быть ошибкой")
	}
}

func storedRow(kind Kind, p Payload, count int32) Stored {
	raw, _ := json.Marshal(p)
	return Stored{
		ID: uuid.New(), WorkspaceID: uuid.New(),
		WorkspaceName: "Команда", WorkspaceSlug: "team",
		Kind: string(kind), SubjectID: uuid.New(), Payload: raw, Count: count,
		FirstAt: time.Now(), LastAt: time.Now(),
	}
}

// Лента отдаёт готовые к показу строки: текст и ссылку собрал реестр, а не экран.
func TestFeed_RendersRows(t *testing.T) {
	store := &fakeStore{
		rows: []Stored{
			storedRow(KindNewSubmissions, Payload{FormTitle: "Заявка", FormSlug: "zayavka"}, 3),
			storedRow(KindOverQuota, Payload{Period: "2026-09"}, 2),
		},
		unread: 2,
	}
	svc := newTestService(&fakeAccess{}, store)

	page, err := svc.Feed(context.Background(), uuid.New(), uuid.Nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("строк %d, ожидалось 2", len(page.Items))
	}
	if page.Items[0].Text != "Заявка — 3 новых ответа" {
		t.Errorf("текст первой строки = %q", page.Items[0].Text)
	}
	if page.Items[0].Link != "/forms/zayavka/submissions" {
		t.Errorf("ссылка первой строки = %q", page.Items[0].Link)
	}
	// Ссылка на тариф собирается из адреса ПРОСТРАНСТВА строки, а не из снимка:
	// пространство человек может переименовать, но не подменить.
	if page.Items[1].Link != "/w/team/plan" {
		t.Errorf("ссылка второй строки = %q", page.Items[1].Link)
	}
	if page.Items[0].Read {
		t.Error("строка без read_at обязана быть непрочитанной")
	}
	if page.Unread != 2 {
		t.Errorf("непрочитанных %d, ожидалось 2", page.Unread)
	}
	if page.NextCursor != uuid.Nil {
		t.Error("страница последняя — курсора быть не должно")
	}
}

// Повод, которого реестр не знает (откат версии, строка из будущего), лента
// пропускает: уведомление без текста хуже отсутствующего, а падать из-за него
// незачем — остальные строки человеку нужны.
func TestFeed_SkipsUnknownKind(t *testing.T) {
	bad := storedRow("telepathy", Payload{}, 1)
	good := storedRow(KindNewSubmissions, Payload{FormTitle: "Заявка", FormSlug: "z"}, 1)
	svc := newTestService(&fakeAccess{}, &fakeStore{rows: []Stored{bad, good}})

	page, err := svc.Feed(context.Background(), uuid.New(), uuid.Nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != good.ID {
		t.Fatalf("ожидалась одна строка (знакомый повод), получено %d", len(page.Items))
	}
}

// Страница берётся с запасом в одну строку: по «лишней» видно, что дальше есть
// ещё, и курсором становится последняя ПОКАЗАННАЯ.
func TestFeed_Pagination(t *testing.T) {
	rows := []Stored{
		storedRow(KindNewSubmissions, Payload{FormTitle: "A", FormSlug: "a"}, 1),
		storedRow(KindNewSubmissions, Payload{FormTitle: "B", FormSlug: "b"}, 1),
		storedRow(KindNewSubmissions, Payload{FormTitle: "C", FormSlug: "c"}, 1),
	}
	store := &fakeStore{rows: rows}
	svc := newTestService(&fakeAccess{}, store)

	page, err := svc.Feed(context.Background(), uuid.New(), uuid.Nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	if store.listLimit != 3 {
		t.Errorf("у хранилища спросили %d строк, ожидалось limit+1 = 3", store.listLimit)
	}
	if len(page.Items) != 2 {
		t.Fatalf("показано %d строк, ожидалось 2", len(page.Items))
	}
	if page.NextCursor != rows[1].ID {
		t.Errorf("курсор = %s, ожидался id последней показанной строки", page.NextCursor)
	}
}

func TestFeed_LimitClamped(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{}, store)

	if _, err := svc.Feed(context.Background(), uuid.New(), uuid.Nil, 5000); err != nil {
		t.Fatal(err)
	}
	if store.listLimit != MaxPageSize+1 {
		t.Errorf("потолок страницы не сработал: спросили %d строк", store.listLimit)
	}
}

func TestMarkRead(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{}, store)
	id := uuid.New()

	if err := svc.MarkRead(context.Background(), uuid.New(), []uuid.UUID{id}); err != nil {
		t.Fatal(err)
	}
	if len(store.markedIDs) != 1 || store.markedIDs[0] != id {
		t.Fatalf("отмечено не то: %+v", store.markedIDs)
	}
	// Пустой список — не повод ходить в БД.
	if err := svc.MarkRead(context.Background(), uuid.New(), nil); err != nil {
		t.Fatal(err)
	}
	if len(store.markedIDs) != 1 {
		t.Fatal("пустой список не должен доезжать до БД")
	}
}

// Удаление — не прочтение: строки не остаётся вовсе, тогда как прочитанная живёт
// историей до уборщика.
func TestDelete(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{}, store)
	id := uuid.New()

	if err := svc.Delete(context.Background(), uuid.New(), id); err != nil {
		t.Fatal(err)
	}
	if len(store.deleted) != 1 || store.deleted[0] != id {
		t.Fatalf("удалено не то: %+v", store.deleted)
	}
}

func TestDeleteAll(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{}, store)

	if err := svc.DeleteAll(context.Background(), uuid.New()); err != nil {
		t.Fatal(err)
	}
	if store.deletedAll != 1 {
		t.Fatalf("очистка ленты не дошла до хранилища: %d", store.deletedAll)
	}
}

// Прочитанное живёт меньше непрочитанного: оно уже сделало свою работу.
func TestCleanup_Retention(t *testing.T) {
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{}
	svc := newTestService(&fakeAccess{}, store).WithClock(func() time.Time { return now })

	n, err := svc.Cleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Errorf("убрано %d строк, хранилище сказало 3", n)
	}
	if !store.purgeRead.Equal(now.Add(-ReadRetention)) {
		t.Errorf("граница прочитанных = %s", store.purgeRead)
	}
	if !store.purgeUnread.Equal(now.Add(-UnreadRetention)) {
		t.Errorf("граница непрочитанных = %s", store.purgeUnread)
	}
	if !store.purgeUnread.Before(store.purgeRead) {
		t.Error("непрочитанные обязаны жить дольше прочитанных")
	}
}
