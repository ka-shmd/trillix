package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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

// SignupProfile — анкета при завершении регистрации: общие вопросы и поля вкладок «Частное
// лицо» (Occupation, Profession) и «Компания или ИП» (CompanyName, Industry, JobPosition).
// nil — вопрос пропущен.
type SignupProfile struct {
	Kind        *string
	Purpose     *string
	Referral    *string
	FullName    *string
	Occupation  *string
	Profession  *string
	CompanyName *string
	Industry    *string
	JobPosition *string
}

// Варианты ответов анкеты. Зеркалит CHECK signup_profiles (0071, 0072) и списки экрана
// «Завершение регистрации» (web/app/src/entities/legal.ts).
var (
	signupKinds       = []string{"person", "company"}
	signupPurposes    = []string{"research", "leads", "events", "booking", "feedback", "quizzes", "other"}
	signupReferrals   = []string{"search", "ads", "social", "recommendation", "article", "other"}
	signupOccupations = []string{"study", "employed", "freelance", "teaching", "science", "other"}
	signupIndustries  = []string{
		"education", "it", "marketing", "healthcare", "retail", "services",
		"manufacturing", "finance", "public", "hr", "events", "other",
	}
	signupPositions = []string{"owner", "marketing", "hr", "product", "analytics", "teaching", "development", "other"}
)

// Потолки свободных полей анкеты в рунах. Зеркалит CHECK signup_profiles (0072).
const (
	maxSignupFullName    = 200
	maxSignupProfession  = 100
	maxSignupCompanyName = 300
)

// SignupProfileOf — анкета аккаунта. Незаполненная отдаётся пустой, а не «не найдено»:
// экран рисует одни и те же поля и в том, и в другом случае.
func (s *Service) SignupProfileOf(ctx context.Context, userID uuid.UUID) (SignupProfile, error) {
	p, err := s.repo.GetSignupProfile(ctx, s.db, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SignupProfile{}, nil
	}
	if err != nil {
		return SignupProfile{}, fmt.Errorf("signup profile %s: %w", userID, err)
	}
	return p, nil
}

// SaveSignupProfile сохраняет анкету целиком: повторная отправка перезаписывает ответы. Поля
// чужой вкладки отбрасываются — человек мог заполнить их и переключиться.
func (s *Service) SaveSignupProfile(ctx context.Context, userID uuid.UUID, p SignupProfile) error {
	p.FullName, p.Profession, p.CompanyName = trimmedOrNil(p.FullName), trimmedOrNil(p.Profession), trimmedOrNil(p.CompanyName)
	if !oneOf(p.Kind, signupKinds) || !oneOf(p.Purpose, signupPurposes) || !oneOf(p.Referral, signupReferrals) ||
		!oneOf(p.Occupation, signupOccupations) || !oneOf(p.Industry, signupIndustries) || !oneOf(p.JobPosition, signupPositions) {
		return fmt.Errorf("%w: такого варианта ответа нет", domain.ErrValidation)
	}
	if tooLong(p.FullName, maxSignupFullName) || tooLong(p.Profession, maxSignupProfession) || tooLong(p.CompanyName, maxSignupCompanyName) {
		return fmt.Errorf("%w: слишком длинный ответ", domain.ErrValidation)
	}
	if p.Kind == nil || *p.Kind != "person" {
		p.Occupation, p.Profession = nil, nil
	}
	if p.Kind == nil || *p.Kind != "company" {
		p.CompanyName, p.Industry, p.JobPosition = nil, nil, nil
	}
	return s.repo.UpsertSignupProfile(ctx, s.db, userID, p)
}

func trimmedOrNil(v *string) *string {
	if v == nil {
		return nil
	}
	t := strings.TrimSpace(*v)
	if t == "" {
		return nil
	}
	return &t
}

func tooLong(v *string, maxRunes int) bool {
	return v != nil && utf8.RuneCountInString(*v) > maxRunes
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
