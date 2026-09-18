package legal

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Repo — доступ к legal_documents поверх sqlc-запросов. Методы принимают исполнителя
// (postgres.DBTX — пул или транзакция). pgx.ErrNoRows пробрасывается как есть: «нет
// строки» от «сломалась база» отличает сервис.
type Repo struct{}

// Insert заводит редакцию; false — она уже была в базе.
func (Repo) Insert(ctx context.Context, db postgres.DBTX, e Edition) (bool, error) {
	n, err := postgres.New(db).InsertLegalDocument(ctx, postgres.InsertLegalDocumentParams{
		ID:                   domain.NewID(),
		Kind:                 string(e.Kind),
		Version:              e.Version,
		Title:                e.Title,
		Body:                 e.Body,
		Sha256:               e.SHA256,
		EffectiveAt:          timestamptz(e.EffectiveAt),
		RequiresReacceptance: e.RequiresReacceptance,
		Draft:                e.Draft,
	})
	if err != nil {
		return false, fmt.Errorf("insert legal document %s/%s: %w", e.Kind, e.Version, err)
	}
	return n == 1, nil
}

func (Repo) Get(ctx context.Context, db postgres.DBTX, kind Kind, version string) (Edition, error) {
	row, err := postgres.New(db).GetLegalDocument(ctx, postgres.GetLegalDocumentParams{
		Kind: string(kind), Version: version,
	})
	if err != nil {
		return Edition{}, err
	}
	return toEdition(row), nil
}

// RewriteDraft перезаписывает черновик; false — редакции нет или она опубликована.
func (Repo) RewriteDraft(ctx context.Context, db postgres.DBTX, e Edition) (bool, error) {
	n, err := postgres.New(db).RewriteDraftLegalDocument(ctx, postgres.RewriteDraftLegalDocumentParams{
		Kind:                 string(e.Kind),
		Version:              e.Version,
		Title:                e.Title,
		Body:                 e.Body,
		Sha256:               e.SHA256,
		EffectiveAt:          timestamptz(e.EffectiveAt),
		RequiresReacceptance: e.RequiresReacceptance,
		Draft:                e.Draft,
	})
	if err != nil {
		return false, fmt.Errorf("rewrite legal document draft %s/%s: %w", e.Kind, e.Version, err)
	}
	return n == 1, nil
}

func (Repo) ListCurrent(ctx context.Context, db postgres.DBTX, now time.Time) ([]Edition, error) {
	rows, err := postgres.New(db).ListCurrentLegalDocuments(ctx, timestamptz(now))
	if err != nil {
		return nil, fmt.Errorf("list current legal documents: %w", err)
	}
	out := make([]Edition, len(rows))
	for i, r := range rows {
		out[i] = toEdition(r)
	}
	return out, nil
}

func (Repo) GetCurrent(ctx context.Context, db postgres.DBTX, kind Kind, now time.Time) (Edition, error) {
	row, err := postgres.New(db).GetCurrentLegalDocument(ctx, postgres.GetCurrentLegalDocumentParams{
		Kind: string(kind), Now: timestamptz(now),
	})
	if err != nil {
		return Edition{}, err
	}
	return toEdition(row), nil
}

func (Repo) GetEffective(ctx context.Context, db postgres.DBTX, kind Kind, version string, now time.Time) (Edition, error) {
	row, err := postgres.New(db).GetEffectiveLegalDocument(ctx, postgres.GetEffectiveLegalDocumentParams{
		Kind: string(kind), Version: version, Now: timestamptz(now),
	})
	if err != nil {
		return Edition{}, err
	}
	return toEdition(row), nil
}

func (Repo) ListVersions(ctx context.Context, db postgres.DBTX, kind Kind, now time.Time) ([]VersionRef, error) {
	rows, err := postgres.New(db).ListLegalDocumentVersions(ctx, postgres.ListLegalDocumentVersionsParams{
		Kind: string(kind), Now: timestamptz(now),
	})
	if err != nil {
		return nil, fmt.Errorf("list legal document versions %s: %w", kind, err)
	}
	out := make([]VersionRef, len(rows))
	for i, r := range rows {
		out[i] = VersionRef{Version: r.Version, EffectiveAt: r.EffectiveAt.Time}
	}
	return out, nil
}

func timestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}

func toEdition(r postgres.LegalDocument) Edition {
	return Edition{
		ID:                   r.ID,
		Kind:                 Kind(r.Kind),
		Version:              r.Version,
		Title:                r.Title,
		Body:                 r.Body,
		SHA256:               r.Sha256,
		EffectiveAt:          r.EffectiveAt.Time,
		RequiresReacceptance: r.RequiresReacceptance,
		Draft:                r.Draft,
	}
}

// ConsentEvent — строка журнала согласий на запись.
type ConsentEvent struct {
	UserID       uuid.UUID
	DocumentID   uuid.UUID
	Action       Action
	Source       Source
	CheckboxText string
	Email        string
	UserAgent    string
}

// LatestEvent — последнее событие человека по виду документа.
type LatestEvent struct {
	Kind       Kind
	DocumentID uuid.UUID
	Version    string
	Action     Action
	At         time.Time
}

// HistoryItem — строка истории согласий.
type HistoryItem struct {
	ID      uuid.UUID
	Kind    Kind
	Version string
	Title   string
	Action  Action
	Source  Source
	At      time.Time
}

func (Repo) TermsAcceptanceMissing(ctx context.Context, db postgres.DBTX, userID uuid.UUID, now time.Time) (bool, error) {
	missing, err := postgres.New(db).TermsAcceptanceMissing(ctx, postgres.TermsAcceptanceMissingParams{
		Now: timestamptz(now), UserID: userID,
	})
	if err != nil {
		return false, fmt.Errorf("terms acceptance missing %s: %w", userID, err)
	}
	return missing, nil
}

func (Repo) InsertEvent(ctx context.Context, db postgres.DBTX, e ConsentEvent) error {
	err := postgres.New(db).InsertConsentEvent(ctx, postgres.InsertConsentEventParams{
		ID:           domain.NewID(),
		UserID:       e.UserID,
		DocumentID:   e.DocumentID,
		Action:       string(e.Action),
		Source:       string(e.Source),
		CheckboxText: e.CheckboxText,
		Email:        e.Email,
		UserAgent:    e.UserAgent,
	})
	if err != nil {
		return fmt.Errorf("insert consent event %s: %w", e.UserID, err)
	}
	return nil
}

func (Repo) LatestEvents(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]LatestEvent, error) {
	rows, err := postgres.New(db).LatestConsentEvents(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("latest consent events %s: %w", userID, err)
	}
	out := make([]LatestEvent, len(rows))
	for i, r := range rows {
		out[i] = LatestEvent{
			Kind: Kind(r.Kind), DocumentID: r.DocumentID, Version: r.Version,
			Action: Action(r.Action), At: r.CreatedAt.Time,
		}
	}
	return out, nil
}

func (Repo) History(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]HistoryItem, error) {
	rows, err := postgres.New(db).ListConsentHistory(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("consent history %s: %w", userID, err)
	}
	out := make([]HistoryItem, len(rows))
	for i, r := range rows {
		out[i] = HistoryItem{
			ID: r.ID, Kind: Kind(r.Kind), Version: r.Version, Title: r.Title,
			Action: Action(r.Action), Source: Source(r.Source), At: r.CreatedAt.Time,
		}
	}
	return out, nil
}
