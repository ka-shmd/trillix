package answerfiles

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Forms — коллаборатор из модуля forms: опубликованная форма по slug. Тот же
// узкий интерфейс, что у submissions: доступ к публичной форме правом не является,
// но черновик и несуществующая обязаны давать одинаковый 404 (инвариант 5).
type Forms interface {
	PublicForm(ctx context.Context, slug string) (forms.PublicForm, error)
	// Get проверяет членство пользователя в воркспейсе формы; чужая или
	// несуществующая → domain.ErrNotFound (анти-IDOR, приватное не раскрывается).
	// Скачиванию нужен только факт доступа, не поля формы.
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
}

// Plans — единственная точка «можно ли» (ADR §10). Реализация — *entitlements.Service.
//
// В отличие от приёма ответа, здесь квота ЖЁСТКАЯ: место в хранилище — это счёт,
// который платит владелец, и «примем, а потом разберёмся» означало бы принимать
// байты, за которые никто не заплатит. Отказ при этом не теряет ответ: файл не
// приложен, форма отправляется без него.
type Plans interface {
	CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
}

// Store — доступ к данным, объявленный потребителем. Реализация — Repo.
type Store interface {
	Insert(ctx context.Context, db postgres.DBTX, f NewFile) error
	ForAnswer(ctx context.Context, db postgres.DBTX, id, submissionID uuid.UUID) (File, error)
	OfFormSubmission(ctx context.Context, db postgres.DBTX, formID, submissionID uuid.UUID) ([]File, error)
	DeleteOrphans(ctx context.Context, db postgres.DBTX, ids []uuid.UUID) error
	Claim(ctx context.Context, db postgres.DBTX, id, submissionID uuid.UUID, formID uuid.UUID, blockID string) (bool, error)
	BySubmissions(ctx context.Context, db postgres.DBTX, ids []uuid.UUID) ([]File, error)
	ByForm(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]File, error)
	KeysByForm(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32) ([]File, error)
	KeysByWorkspace(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, limit int32) ([]File, error)
	Get(ctx context.Context, db postgres.DBTX, id uuid.UUID) (File, error)
	Orphans(ctx context.Context, db postgres.DBTX, olderThan time.Time, limit int32) ([]File, error)
	Delete(ctx context.Context, db postgres.DBTX, ids []uuid.UUID) error
}

var _ Store = Repo{}

// Service — выдача слотов и жизненный цикл файлов ответа.
type Service struct {
	db     postgres.DBTX
	repo   Store
	bucket *Bucket
	forms  Forms
	plans  Plans
}

// NewService собирает сервис. db — пул: транзакцию открывает вызывающий (приём
// ответа), и своей у модуля нет.
func NewService(db postgres.DBTX, repo Store, bucket *Bucket, f Forms, plans Plans) *Service {
	return &Service{db: db, repo: repo, bucket: bucket, forms: f, plans: plans}
}

// Slot — что получает браузер: адрес загрузки, обязательные заголовки и id, который
// уедет в ответ формы. Сам адрес — учётные данные: в логи он не пишется.
type Slot struct {
	ID          uuid.UUID
	URL         string
	ContentType string
	// ExpiresIn — сколько живёт адрес. Клиенту нужно, чтобы не начинать загрузку
	// заведомо просроченной подписью.
	ExpiresIn time.Duration
}

// SlotRequest — заявка на загрузку одного файла.
type SlotRequest struct {
	Slug        string
	BlockID     string
	FileName    string
	SizeBytes   int64
	ContentType string
}

// IssueSlot выдаёт право загрузить один файл. Порядок проверок — от самого дешёвого
// и самого «чужого» к самому дорогому; ни одна из них не может быть перенесена в
// клиент, потому что клиент здесь — посторонний.
func (s *Service) IssueSlot(ctx context.Context, req SlotRequest) (Slot, error) {
	pf, err := s.forms.PublicForm(ctx, req.Slug)
	if err != nil {
		return Slot{}, err
	}
	// Закрытая форма файлов не принимает: приём ответа всё равно ответит 410, и
	// слот означал бы объекты в бакете под ответ, которого не будет.
	if domain.ClosedByStatusOrDate(pf.Status, pf.CloseAt, time.Now().UTC()) {
		return Slot{}, domain.ErrFormClosed
	}

	schema, err := domain.ValidateSchema(pf.Schema)
	if err != nil {
		return Slot{}, fmt.Errorf("parse published schema for %s: %v", req.Slug, err)
	}
	block, ok := findFileBlock(schema, req.BlockID)
	if !ok {
		// Вопроса нет или он не про файлы — ошибка ввода, а не 404 формы: форма
		// существует и опубликована, и скрывать тут нечего.
		return Slot{}, fmt.Errorf("%w: вопрос не принимает файлы", domain.ErrValidation)
	}

	ft, ok := domain.LookupFileType(req.ContentType)
	if !ok {
		return Slot{}, fmt.Errorf("%w: такой тип файла загрузить нельзя", domain.ErrValidation)
	}
	if !domain.FamilyAllowed(block.Settings.Accept, ft.Family) {
		return Slot{}, fmt.Errorf("%w: этот вопрос не принимает такие файлы", domain.ErrValidation)
	}
	_, maxSizeMiB := domain.FileLimits(block)
	maxBytes := int64(maxSizeMiB) << 20
	if req.SizeBytes <= 0 || req.SizeBytes > maxBytes {
		return Slot{}, fmt.Errorf("%w: файл больше %d МиБ", domain.ErrTooLarge, maxSizeMiB)
	}

	// Квота хранилища — последней: она стоит запроса в базу, а всё, что можно
	// отвергнуть дешевле, уже отвергнуто.
	d, err := s.plans.CheckWorkspace(ctx, pf.WorkspaceID, entitlements.StoragePerWorkspace)
	if err != nil {
		return Slot{}, fmt.Errorf("check storage quota of workspace %s: %w", pf.WorkspaceID, err)
	}
	if !d.Allowed || (d.Limit != nil && d.Used+req.SizeBytes > *d.Limit) {
		// ЕДИНСТВЕННЫЙ отказ респонденту по тарифу владельца, и он осознанный.
		// Правило «квота мягкая, ответ принимается всегда» (ADR §10) держится на
		// том, что лишняя строка в базе ничего не стоит и её можно просто
		// пометить. С байтами так нельзя: принять файл сверх оплаченного места —
		// это счёт, который никто не выставлял. Ответ при этом НЕ теряется:
		// отказано файлу, форма отправляется без него.
		return Slot{}, fmt.Errorf("%w: место в хранилище закончилось", domain.ErrPlanRequired)
	}

	id := domain.NewID()
	key := ObjectKey(pf.WorkspaceID, pf.FormID, id, ft.Ext)
	url, err := s.bucket.UploadURL(key, ft.MIME, req.SizeBytes)
	if err != nil {
		return Slot{}, err
	}
	// Строка пишется ДО выдачи адреса: объект, о котором нет записи, не найдёт ни
	// квота, ни чистка сирот — он станет вечным мусором в бакете.
	err = s.repo.Insert(ctx, s.db, NewFile{
		ID:           id,
		WorkspaceID:  pf.WorkspaceID,
		FormID:       pf.FormID,
		BlockID:      block.ID,
		ObjectKey:    key,
		OriginalName: domain.SanitizeFileName(req.FileName),
		SizeBytes:    req.SizeBytes,
		ContentType:  ft.MIME,
	})
	if err != nil {
		return Slot{}, err
	}
	return Slot{ID: id, URL: url, ContentType: ft.MIME, ExpiresIn: PutTTL}, nil
}

// Verify сверяет названные в ответе загрузки с базой и хранилищем — ДО того, как
// ответ будет записан. Проверяется всё, что клиент мог подменить: та ли форма, тот
// ли вопрос, существует ли объект и совпал ли его размер с подписанным.
//
// Сетевой поход в хранилище здесь, а не в транзакции приёма, намеренно: держать
// транзакцию открытой на время HEAD к S3 значит отдать самый атакуемый эндпоинт во
// власть чужого таймаута.
//
// submissionID нужен ровно для повторной отправки: приём идемпотентен по нему, и на
// ретрае после обрыва сети файлы УЖЕ заявлены этим же ответом. Сверка, знающая
// только про незаявленные, отвечала бы 422 на каждом таком повторе — притом что
// ответ давно принят.
func (s *Service) Verify(ctx context.Context, formID, submissionID uuid.UUID, byBlock map[string][]string) error {
	for blockID, ids := range byBlock {
		for _, raw := range ids {
			id, err := uuid.Parse(raw)
			if err != nil {
				return fmt.Errorf("%w: неизвестный файл", domain.ErrValidation)
			}
			f, err := s.repo.ForAnswer(ctx, s.db, id, submissionID)
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					// Заявленная ЧУЖИМ ответом, чужая и несуществующая — один
					// случай: различать их наружу значило бы отвечать на вопрос
					// «а такой файл вообще есть?».
					return fmt.Errorf("%w: неизвестный файл", domain.ErrValidation)
				}
				return err
			}
			if f.FormID != formID || f.BlockID != blockID {
				return fmt.Errorf("%w: файл приложен не к тому вопросу", domain.ErrValidation)
			}
			size, err := s.bucket.Size(ctx, f.ObjectKey)
			if err != nil {
				if errors.Is(err, blob.ErrNotFound) {
					return fmt.Errorf("%w: файл не загружен", domain.ErrValidation)
				}
				return err
			}
			if size != f.SizeBytes {
				// Размер входит в подпись, поэтому расхождение означает не ошибку
				// клиента, а попытку обойти потолок. Объект сносим сразу: ответ с
				// ним всё равно не будет принят.
				_ = s.bucket.Remove(ctx, f.ObjectKey)
				return fmt.Errorf("%w: размер файла не совпадает с заявленным", domain.ErrValidation)
			}
		}
	}
	return nil
}

// Claim привязывает проверенные загрузки к ответу. Зовётся в ТОЙ ЖЕ транзакции, что
// вставка ответа: файл, заявленный без ответа, нарушил бы внешний ключ, а ответ без
// заявленных файлов остался бы со ссылками на строки, которые через сутки унесёт
// чистка сирот.
func (s *Service) Claim(ctx context.Context, tx pgx.Tx, submissionID, formID uuid.UUID, byBlock map[string][]string) error {
	for blockID, ids := range byBlock {
		for _, raw := range ids {
			id, err := uuid.Parse(raw)
			if err != nil {
				return fmt.Errorf("%w: неизвестный файл", domain.ErrValidation)
			}
			// Одним утверждением, без предварительного чтения: условие запроса
			// («та форма, тот вопрос, не заявлена чужим ответом») и есть проверка,
			// и только база может выполнить её без окна между чтением и записью.
			// Ноль строк — загрузка чужая, не та или уже заявлена другим ответом.
			ok, err := s.repo.Claim(ctx, tx, id, submissionID, formID, blockID)
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("%w: неизвестный файл", domain.ErrValidation)
			}
		}
	}
	return nil
}

// findFileBlock — блок с таким id, если он есть и принимает файлы. Настройки берутся
// из ОПУБЛИКОВАННОЙ версии: черновик автора на выданные подписи не влияет, иначе
// потолок можно было бы поднять после выдачи слота.
func findFileBlock(schema domain.FormSchema, blockID string) (domain.Block, bool) {
	for i := range schema.Blocks {
		b := schema.Blocks[i]
		if b.ID == blockID && b.Type == domain.BlockFile {
			return b, true
		}
	}
	return domain.Block{}, false
}
