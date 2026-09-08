package workspaces

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const (
	// joinLinkTTL — сутки. Короче недельного срока прежних приглашений по почте
	// намеренно (решение владельца 2026-09-08): у ссылки нет адресата, поэтому
	// её прочность держит только срок — попавшая в чужой чат ссылка отдаёт
	// доступ к ответам респондентов тому, кто её нашёл.
	joinLinkTTL = 24 * time.Hour
	// joinLinkTokenBytes — 256 бит случайности. Токен лежит в базе СЫРЫМ
	// (ADR §10), поэтому длина здесь защищает не от подбора по дампу, а от
	// подбора по сети.
	joinLinkTokenBytes = 32
)

// JoinLink — ссылка-приглашение в пространство: единственный способ позвать
// человека (приглашение по адресу почты вырезано, ADR §10).
//
// Отличается от прежнего приглашения тремя вещами сразу, и потому это отдельный
// объект: она многоразовая, она не называет человека, и её отзывают явно.
type JoinLink struct {
	Token       string
	WorkspaceID uuid.UUID
	Role        Role
	ExpiresAt   time.Time
	// WorkspaceName заполняет только просмотр по токену (GetJoinLinkByToken):
	// зовомому надо понять, куда его зовут, а id пространства ему знать рано.
	WorkspaceName string
}

// Expired сообщает, что срок ссылки вышел.
func (l JoinLink) Expired(now time.Time) bool { return !now.Before(l.ExpiresAt) }

// JoinLinkStore — данные ссылок (часть Store, вынесена для читаемости).
type JoinLinkStore interface {
	CreateJoinLink(ctx context.Context, db postgres.DBTX, token string, workspaceID uuid.UUID, role string, createdBy uuid.UUID, expiresAt time.Time) error
	// RevokeJoinLink гасит живую ссылку пространства; 0 строк означает «живой не
	// было», и это не ошибка.
	RevokeJoinLink(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) (int64, error)
	// ActiveJoinLink — живая ссылка пространства; pgx.ErrNoRows означает «нет».
	// Истёкшую отдаёт тоже: срок разбирает сервис, чтобы кабинет мог сказать
	// «истекла» вместо «её нет».
	ActiveJoinLink(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) (JoinLink, error)
	JoinLinkByToken(ctx context.Context, db postgres.DBTX, token string) (JoinLink, error)
	// AddMember вводит человека в пространство — единственный путь, каким состав
	// растёт после заведения пространства.
	AddMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, role string) error
	PurgeExpiredJoinLinks(ctx context.Context, db postgres.DBTX) (int64, error)
}

// JoinLink отдаёт живую ссылку пространства для кабинета. Право — member.manage:
// ссылка это способ раздать доступ, и знать её вправе тот, кто вправе раздавать.
//
// Истёкшая отдаётся как есть, а не превращается в «ссылки нет»: кабинету надо
// сказать «истекла, создайте новую», и это другой ответ человеку.
func (s *Service) JoinLink(ctx context.Context, userID, workspaceID uuid.UUID) (JoinLink, error) {
	if err := s.Can(ctx, workspaceID, userID, domain.ActionMemberManage); err != nil {
		return JoinLink{}, err
	}
	link, err := s.repo.ActiveJoinLink(ctx, s.db, workspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return JoinLink{}, domain.ErrNotFound
		}
		return JoinLink{}, err
	}
	return link, nil
}

// CreateJoinLink выписывает новую ссылку, гася прежнюю. Отзыв и выписка — одной
// транзакцией: частичный уникальный индекс держит «одна живая на пространство»,
// поэтому между ними не должно быть состояния с двумя годными ссылками.
//
// Всегда ротация, а не «отдать существующую»: команда человека здесь — «дай мне
// ссылку, которую я разошлю», и молча отдавать вчерашнюю значит продлевать срок
// мимо решения о сутках.
func (s *Service) CreateJoinLink(ctx context.Context, userID, workspaceID uuid.UUID) (JoinLink, error) {
	if err := s.Can(ctx, workspaceID, userID, domain.ActionMemberManage); err != nil {
		return JoinLink{}, err
	}
	token, err := newJoinToken()
	if err != nil {
		return JoinLink{}, err
	}
	expires := time.Now().Add(joinLinkTTL)

	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if _, e := s.repo.RevokeJoinLink(ctx, tx, workspaceID); e != nil {
			return e
		}
		return s.repo.CreateJoinLink(ctx, tx, token, workspaceID, string(RoleEditor), userID, expires)
	})
	if err != nil {
		return JoinLink{}, err
	}
	return JoinLink{Token: token, WorkspaceID: workspaceID, Role: RoleEditor, ExpiresAt: expires}, nil
}

// RevokeJoinLink гасит ссылку без выписки новой: способ закрыть пространство,
// когда ссылка ушла не туда.
//
// Ноль погашенных строк — не ошибка: «ссылки не было» и «ссылку погасили» дают
// человеку одно и то же состояние, и различать их отказом было бы враньём про
// результат.
func (s *Service) RevokeJoinLink(ctx context.Context, userID, workspaceID uuid.UUID) error {
	if err := s.Can(ctx, workspaceID, userID, domain.ActionMemberManage); err != nil {
		return err
	}
	_, err := s.repo.RevokeJoinLink(ctx, s.db, workspaceID)
	return err
}

// PreviewJoinLink показывает по токену, куда зовут. Аутентификации не требует
// намеренно — аккаунта у зовомого может ещё не быть, и понять, куда он идёт, он
// должен до регистрации.
//
// Неизвестный, отозванный и истёкший токены неотличимы снаружи: у человека одно
// действие на все три случая — попросить ссылку заново, а различение позволяло бы
// перебором выяснять, какие токены существовали.
func (s *Service) PreviewJoinLink(ctx context.Context, token string) (JoinLink, error) {
	link, err := s.repo.JoinLinkByToken(ctx, s.db, token)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return JoinLink{}, domain.ErrNotFound
		}
		return JoinLink{}, err
	}
	if link.Expired(time.Now()) {
		return JoinLink{}, domain.ErrLinkExpired
	}
	return link, nil
}

// JoinByLink вводит вошедшего человека в пространство редактором.
//
// ⚠ ЗДЕСЬ ЕДИНСТВЕННАЯ ПРОВЕРКА МЕСТ. У приглашения по почте их было две — на
// выписке и на принятии, — потому что выписка называла человека. Ссылка не
// называет никого, выписывается один раз и приводит скольких угодно, поэтому
// считать места на выписке бессмысленно: к моменту входа число участников уже
// другое.
//
// Повторный вход того же человека — УСПЕХ, а не отказ: он и так участник, ссылка
// сработала, и «конфликт» на этом месте выглядел бы поломкой ссылки.
func (s *Service) JoinByLink(ctx context.Context, userID uuid.UUID, token string) (Workspace, error) {
	link, err := s.PreviewJoinLink(ctx, token)
	if err != nil {
		return Workspace{}, err
	}

	if _, err := s.repo.MemberRole(ctx, s.db, link.WorkspaceID, userID); err == nil {
		return s.repo.GetWorkspace(ctx, s.db, link.WorkspaceID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Workspace{}, err
	}

	d, err := s.plans.CheckWorkspace(ctx, link.WorkspaceID, entitlements.MembersPerWorkspace)
	if err != nil {
		return Workspace{}, err
	}
	if !d.Allowed {
		return Workspace{}, domain.ErrPlanRequired
	}

	if err := s.repo.AddMember(ctx, s.db, link.WorkspaceID, userID, string(link.Role)); err != nil {
		return Workspace{}, err
	}
	return s.repo.GetWorkspace(ctx, s.db, link.WorkspaceID)
}

// newJoinToken — 256-битный случайный токен в base64url. В отличие от сессий и
// прежних приглашений, в базу он ложится СЫРЫМ (ADR §10): ссылку копируют
// повторно, а из SHA-256 её не восстановить.
func newJoinToken() (string, error) {
	b := make([]byte, joinLinkTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("workspaces: read token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// PurgeExpiredJoinLinks — периодическая чистка истёкших и отозванных (аналог
// уборки токенов сброса пароля). Заводится вместе с индексом по expires_at:
// индекс, обещающий уборщика, которого не наняли, — недоделка, а не оптимизация.
func (s *Service) PurgeExpiredJoinLinks(ctx context.Context) (int64, error) {
	return s.repo.PurgeExpiredJoinLinks(ctx, s.db)
}

// JoinURL — адрес, по которому человек открывает ссылку. Собирается сервисом, а
// не кабинетом: origin кабинета знает конфигурация, а не браузер.
func (s *Service) JoinURL(token string) string {
	return s.appBaseURL + "/join/" + token
}
