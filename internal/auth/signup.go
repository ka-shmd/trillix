package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Завершение регистрации (docs/design/signup-consent.md): гейт согласия перед кабинетом,
// отметка о завершении, анкета и очистка брошенных регистраций.

// abandonedSignupTTL — сколько живёт аккаунт, не принявший условия. Срок назван в
// Пользовательском соглашении (п. 2.3) и в политике: правка здесь — правка документов.
const abandonedSignupTTL = 7 * 24 * time.Hour

// consentGate — согласия глазами auth (реализация — *legal.Service, подключается
// WithConsents). Объявлен здесь, а не импортом: legal стоит на RequireSession из auth.
type consentGate interface {
	ConsentRequired(ctx context.Context, userID uuid.UUID) (bool, error)
}

// WithConsents подключает гейт согласия. Отдельный метод, а не аргумент NewService:
// legal собирается после auth.
func (s *Service) WithConsents(c consentGate) *Service {
	s.consents = c
	return s
}

// errConsentGateMissing — гейт не подключён. RequireAuth с ним отвечает 500 на любой
// приватный запрос: забытое подключение видно сразу, а не пропускает всех молча.
var errConsentGateMissing = errors.New("auth: гейт согласия не подключён (WithConsents)")

// ConsentRequired — закрыт ли кабинет до принятия действующей редакции соглашения.
func (s *Service) ConsentRequired(ctx context.Context, userID uuid.UUID) (bool, error) {
	if s.consents == nil {
		return false, errConsentGateMissing
	}
	required, err := s.consents.ConsentRequired(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("consent required %s: %w", userID, err)
	}
	return required, nil
}

// MarkSignupCompleted ставит отметку о завершении регистрации. Вызывает legal той же
// транзакцией, что пишет первое принятие соглашения; уже стоящую отметку не двигает.
func (s *Service) MarkSignupCompleted(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error {
	return s.repo.MarkSignupCompleted(ctx, db, userID)
}

// SignupProfile — анкета при завершении регистрации. nil — вопрос пропущен.
type SignupProfile struct {
	Kind     *string
	Purpose  *string
	Referral *string
}

// Варианты ответов анкеты. Зеркалит CHECK signup_profiles (0071) и список на экране
// «Завершение регистрации» в кабинете.
var (
	signupKinds     = []string{"person", "company"}
	signupPurposes  = []string{"research", "leads", "events", "booking", "feedback", "quizzes", "other"}
	signupReferrals = []string{"search", "ads", "social", "recommendation", "article", "other"}
)

// SaveSignupProfile сохраняет анкету целиком: повторная отправка перезаписывает ответы.
func (s *Service) SaveSignupProfile(ctx context.Context, userID uuid.UUID, p SignupProfile) error {
	if !oneOf(p.Kind, signupKinds) || !oneOf(p.Purpose, signupPurposes) || !oneOf(p.Referral, signupReferrals) {
		return fmt.Errorf("%w: такого варианта ответа нет", domain.ErrValidation)
	}
	return s.repo.UpsertSignupProfile(ctx, s.db, userID, p)
}

func oneOf(v *string, allowed []string) bool {
	if v == nil {
		return true
	}
	for _, a := range allowed {
		if *v == a {
			return true
		}
	}
	return false
}

// DeleteAbandonedSignups удаляет аккаунты, не принявшие условия за abandonedSignupTTL.
func (s *Service) DeleteAbandonedSignups(ctx context.Context) (int64, error) {
	return s.repo.DeleteAbandonedSignups(ctx, s.db, time.Now().Add(-abandonedSignupTTL))
}
