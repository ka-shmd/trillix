package integrations

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Access — права в пространстве глазами этого модуля (internal/workspaces).
// Спрашивается ДЕЙСТВИЕ, а не роль (ADR §10). Can сам различает два отказа:
// не участник → ErrNotFound (404, чужое не раскрывается), участник без права →
// ErrForbidden (403).
type Access interface {
	Can(ctx context.Context, workspaceID, userID uuid.UUID, action domain.Action) error
}

// Store — доступ к данным, объявленный потребителем. Реализация — Repo.
type Store interface {
	Upsert(ctx context.Context, db postgres.DBTX, c NewConnection) error
	Get(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, provider string) (Connection, error)
	Delete(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, provider string) ([]byte, error)
}

var _ Store = Repo{}

// Provider — внешний сервис, к которому подключаются. Интерфейс, а не *Google:
// на его место в тестах встаёт httptest-сервер, а вторым провайдером (Excel
// Online, Airtable) станет вторая реализация без правки сервиса.
type Provider interface {
	Provider() string
	AuthURL(state, verifier string) string
	Exchange(ctx context.Context, code, verifier string) (Tokens, error)
	Refresh(ctx context.Context, refresh string) (Tokens, error)
	Account(ctx context.Context, accessToken string) (Account, error)
	Revoke(ctx context.Context, refresh string) error
}

// Service — подключение внешних аккаунтов к пространству.
type Service struct {
	db     postgres.DBTX
	repo   Store
	access Access
	google Provider
	// key — общий секрет приложения (FORM_TOKEN_SECRET). Из него HKDF выводит
	// ключ шифрования refresh-токенов; сам он здесь не используется ни для чего
	// другого и наружу не отдаётся.
	key []byte
}

func NewService(db postgres.DBTX, repo Store, access Access, google Provider, key []byte) *Service {
	return &Service{db: db, repo: repo, access: access, google: google, key: key}
}

// Enabled отвечает, настроен ли провайдер на этом контуре. Не настроен (нет
// ключей в env) — эндпоинты отдают 404, а экран говорит об этом человеческим
// текстом: dev-контур без проекта в Google Cloud обязан оставаться рабочим.
func (s *Service) Enabled() bool { return s.google != nil }

// Status — состояние подключения пространства.
type Status struct {
	// Enabled — настроен ли провайдер на этом контуре (ключи в env). Отдельно
	// от Connected: «интеграции здесь нет вовсе» и «есть, но не подключена» —
	// разные экраны, и путать их значит советовать человеку нажать кнопку,
	// которой у него не появится.
	Enabled     bool
	Connected   bool
	Email       string
	ConnectedBy uuid.UUID
	ConnectedAt time.Time
	// CanManage — может ли спрашивающий подключать и отключать. Экран рисует
	// кнопку по нему, а не по роли: роль вне internal/workspaces не спрашивают.
	CanManage bool
}

// Status читает состояние. Право на чтение — ActionIntegrationRead: видеть,
// подключён ли аккаунт, вправе любой участник (иначе редактор не поймёт, почему
// ответы куда-то едут), а менять — нет.
func (s *Service) Status(ctx context.Context, userID, workspaceID uuid.UUID) (Status, error) {
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationRead); err != nil {
		return Status{}, err
	}

	canManage, err := s.canManage(ctx, workspaceID, userID)
	if err != nil {
		return Status{}, err
	}
	if !s.Enabled() {
		return Status{CanManage: canManage}, nil
	}

	conn, err := s.repo.Get(ctx, s.db, workspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		// Нет подключения — штатное состояние экрана, а не ошибка.
		return Status{Enabled: true, CanManage: canManage}, nil
	}
	if err != nil {
		return Status{}, fmt.Errorf("integration status: %w", err)
	}
	return Status{
		Enabled:     true,
		Connected:   true,
		Email:       conn.Email,
		ConnectedBy: conn.ConnectedBy,
		ConnectedAt: conn.ConnectedAt,
		CanManage:   canManage,
	}, nil
}

// canManage отвечает на «можно ли управлять» без отказа наружу: для экрана это
// не ошибка, а состояние кнопки. Отличать отказ в праве от сбоя БД обязательно —
// иначе упавший запрос показал бы редактору чужие возможности как свои.
func (s *Service) canManage(ctx context.Context, workspaceID, userID uuid.UUID) (bool, error) {
	err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, domain.ErrForbidden):
		return false, nil
	default:
		return false, err
	}
}

// StartURL — ссылка на экран согласия провайдера. Право спрашивается ДО ухода к
// провайдеру: иначе редактор проходил бы согласие Google, чтобы получить отказ
// на возврате, уже отдав приложению доступ к своему Диску.
func (s *Service) StartURL(ctx context.Context, userID, workspaceID uuid.UUID, state, verifier string) (string, error) {
	if !s.Enabled() {
		return "", domain.ErrNotFound
	}
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage); err != nil {
		return "", err
	}
	return s.google.AuthURL(state, verifier), nil
}

// Connect завершает подключение: меняет код на токены, узнаёт аккаунт и кладёт
// refresh шифротекстом.
//
// Право проверяется ПОВТОРНО, а не считается доказанным подписанной cookie
// похода: между началом и возвратом человека могли лишить роли, и cookie об этом
// не знает (инвариант 1 — id из запроса правом доступа не является).
func (s *Service) Connect(ctx context.Context, userID, workspaceID uuid.UUID, code, verifier string) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage); err != nil {
		return err
	}

	tokens, err := s.google.Exchange(ctx, code, verifier)
	if err != nil {
		return err
	}
	account, err := s.google.Account(ctx, tokens.Access)
	if err != nil {
		return err
	}
	sealed, err := sealToken(s.key, tokens.Refresh)
	if err != nil {
		return err
	}

	return s.repo.Upsert(ctx, s.db, NewConnection{
		ID:            domain.NewID(),
		WorkspaceID:   workspaceID,
		Provider:      s.google.Provider(),
		ExternalID:    account.ID,
		Email:         account.Email,
		RefreshSealed: sealed,
		Scopes:        tokens.Scopes,
		ConnectedBy:   userID,
	})
}

// Disconnect отключает аккаунт от пространства. Привязки форм уносит каскад БД.
//
// Отзыв согласия у провайдера — best effort и НЕ гейтит удаление: недоступный
// Google не должен запирать человека в подключении, которое он разрывает.
// Неудача уходит в лог — там же, где её увидит человек за логом.
func (s *Service) Disconnect(ctx context.Context, userID, workspaceID uuid.UUID) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage); err != nil {
		return err
	}

	sealed, err := s.repo.Delete(ctx, s.db, workspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		// Отключать нечего — уже отключено. Идемпотентно: повторный запрос из
		// второй вкладки не должен краснеть.
		return nil
	}
	if err != nil {
		return fmt.Errorf("disconnect integration: %w", err)
	}

	refresh, err := openToken(s.key, sealed)
	if err != nil {
		// Токен не расшифровался (ротация ключа) — отзывать нечего, но строки
		// уже нет, и это правильный исход: человек отключился.
		httpserver.LoggerFrom(ctx).Warn("integration token not decrypted on disconnect",
			slog.String("workspace_id", workspaceID.String()))
		return nil
	}
	if err := s.google.Revoke(ctx, refresh); err != nil {
		httpserver.LoggerFrom(ctx).Warn("integration token not revoked at provider",
			slog.String("workspace_id", workspaceID.String()),
			slog.String("error", err.Error()))
	}
	return nil
}
