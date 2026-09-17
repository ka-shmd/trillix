package forms

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Согласие на обработку персональных данных — раздел «Персональные данные» в
// настройках формы (docs/design/privacy-consent.md). Живая настройка с ревизиями:
// сохранение с изменениями пишет новую строку form_consent_revisions и делает её
// текущей, правка действует на опубликованной форме сразу, без перепубликации.

// ConsentState — раздел настроек, как его видит кабинет.
type ConsentState struct {
	Enabled  bool
	Settings domain.ConsentSettings
	// RevisionID/UpdatedAt — текущая ревизия; nil у формы, где раздел не сохраняли.
	RevisionID *uuid.UUID
	UpdatedAt  *time.Time
}

func consentStateOf(rev ConsentRevision) ConsentState {
	id, at := rev.ID, rev.CreatedAt
	return ConsentState{Enabled: rev.Enabled, Settings: rev.Settings, RevisionID: &id, UpdatedAt: &at}
}

// currentConsent — текущая ревизия формы; ok = false, если раздел не сохраняли.
func (s *Service) currentConsent(ctx context.Context, formID uuid.UUID) (ConsentRevision, bool, error) {
	rev, err := s.repo.GetFormConsent(ctx, s.db, formID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ConsentRevision{}, false, nil
	}
	if err != nil {
		return ConsentRevision{}, false, err
	}
	return rev, true, nil
}

// Consent — раздел «Персональные данные» формы.
func (s *Service) Consent(ctx context.Context, userID, formID uuid.UUID) (ConsentState, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormRead)
	if err != nil {
		return ConsentState{}, err
	}
	rev, ok, err := s.currentConsent(ctx, form.ID)
	if err != nil {
		return ConsentState{}, err
	}
	if !ok {
		return ConsentState{Settings: domain.NormalizeConsentSettings(domain.ConsentSettings{})}, nil
	}
	return consentStateOf(rev), nil
}

// SaveConsent сохраняет раздел. Новая ревизия пишется, только если что-то изменилось
// (тумблер, настройки или версия шаблона): одинаковые ревизии подряд ничего не
// доказывают и только множат строки.
//
// Той же транзакцией реквизиты включённого согласия с типовыми документами ложатся в
// список пространства (спека §3.6) — подсказку для других форм.
func (s *Service) SaveConsent(ctx context.Context, userID, formID uuid.UUID, enabled bool, settings domain.ConsentSettings) (ConsentState, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return ConsentState{}, err
	}
	settings = domain.NormalizeConsentSettings(settings)
	if err := domain.ValidateConsentSettings(enabled, settings); err != nil {
		return ConsentState{}, err
	}

	cur, ok, err := s.currentConsent(ctx, form.ID)
	if err != nil {
		return ConsentState{}, err
	}
	switch {
	case ok && cur.Enabled == enabled && cur.Template == domain.ConsentTemplateVersion && cur.Settings == settings:
		return consentStateOf(cur), nil
	case !ok && !enabled && settings == domain.NormalizeConsentSettings(domain.ConsentSettings{}):
		return ConsentState{Settings: settings}, nil
	}

	var saved ConsentRevision
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		var err error
		saved, err = s.repo.InsertConsentRevision(ctx, tx, NewConsentRevision{
			ID:        domain.NewID(),
			FormID:    form.ID,
			Enabled:   enabled,
			Settings:  settings,
			Template:  domain.ConsentTemplateVersion,
			CreatedBy: userID,
		})
		if err != nil {
			return err
		}
		n, err := s.repo.SetFormConsentRevision(ctx, tx, form.ID, form.WorkspaceID, saved.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return domain.ErrNotFound
		}
		if enabled && settings.Documents == domain.ConsentDocTemplate && domain.ConsentOperatorComplete(settings.Operator) {
			return s.repo.RememberConsentOperator(ctx, tx, form.WorkspaceID, settings.Operator)
		}
		return nil
	})
	if err != nil {
		return ConsentState{}, err
	}
	return consentStateOf(saved), nil
}

// ConsentPreview — оба документа по несохранённым настройкам, для предпросмотра и
// заготовки своего текста. Перечень данных и заголовок берутся из ЧЕРНОВИКА: автор
// правит форму и видит документ той формы, которую собирает.
func (s *Service) ConsentPreview(ctx context.Context, userID, formID uuid.UUID, settings domain.ConsentSettings) (consent, policy domain.ConsentDocument, err error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormRead)
	if err != nil {
		return domain.ConsentDocument{}, domain.ConsentDocument{}, err
	}
	settings = domain.NormalizeConsentSettings(settings)
	if err := domain.ValidateConsentSettings(false, settings); err != nil {
		return domain.ConsentDocument{}, domain.ConsentDocument{}, err
	}
	// Черновик прошёл валидатор на сохранении; не разобравшийся (дефолт БД без блоков)
	// даёт документ без перечня вопросов, а не отказ предпросмотру.
	parsed, _ := domain.ValidateSchema(form.DraftSchema)
	in := consentDocInput(parsed, form.Title)
	consent, err = domain.RenderConsentDocument(domain.ConsentDocConsent, settings, domain.ConsentTemplateVersion, in)
	if err != nil {
		return domain.ConsentDocument{}, domain.ConsentDocument{}, err
	}
	policy, err = domain.RenderConsentDocument(domain.ConsentDocPolicy, settings, domain.ConsentTemplateVersion, in)
	if err != nil {
		return domain.ConsentDocument{}, domain.ConsentDocument{}, err
	}
	return consent, policy, nil
}

// consentDocInput — заголовок и перечень вопросов документа. fallbackTitle — колонка
// forms.title у документа без блока заголовка.
func consentDocInput(schema domain.FormSchema, fallbackTitle string) domain.ConsentDocInput {
	title := fallbackTitle
	if t, spoke := domain.FormTitle(schema); spoke {
		title = t
	}
	questions := domain.QuestionOrder([]domain.VersionedSchema{{Version: 1, Schema: schema}})
	items := make([]string, 0, len(questions))
	for _, q := range questions {
		items = append(items, q.Label)
	}
	return domain.ConsentDocInput{FormTitle: title, DataItems: items}
}

// ConsentRevisionEnabled — ревизия принадлежит форме и согласие по ней включено.
// Нужен приёму ответа: id ревизии приезжает от респондента и правом не является.
func (s *Service) ConsentRevisionEnabled(ctx context.Context, formID, revisionID uuid.UUID) (bool, error) {
	rev, err := s.repo.GetConsentRevision(ctx, s.db, formID, revisionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return rev.Enabled, nil
}

// PublicConsentDocument — документ ревизии для страницы на домене форм. Перечень данных и
// название формы — всегда по ТЕКУЩЕЙ опубликованной версии: номер старой версии публично
// не принимается, иначе по нему открывались бы вопросы, которые автор с формы снял
// (решение владельца 2026-09-17). Реквизиты и текст — по ревизии, какой бы старой она ни была.
//
// Видимость — как у отдачи формы: черновик и форма удалённого владельца → 404, пароль
// без токена → ErrFormLocked. Выключенная ревизия галочки не показывала и документа не
// имеет → 404.
func (s *Service) PublicConsentDocument(ctx context.Context, slug string, kind domain.ConsentDocKind, revisionID uuid.UUID, unlock string) (domain.ConsentDocument, error) {
	if kind != domain.ConsentDocConsent && kind != domain.ConsentDocPolicy {
		return domain.ConsentDocument{}, domain.ErrNotFound
	}
	pf, err := s.PublicForm(ctx, slug)
	if err != nil {
		return domain.ConsentDocument{}, err
	}
	if err := s.VerifyUnlock(pf.FormID, pf.PasswordSealed, unlock); err != nil {
		return domain.ConsentDocument{}, err
	}
	rev, err := s.repo.GetConsentRevision(ctx, s.db, pf.FormID, revisionID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !rev.Enabled) {
		return domain.ConsentDocument{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.ConsentDocument{}, err
	}
	// %v, а не %w: ошибка разбора несёт ErrValidation, и 422 с внутренним текстом ушёл
	// бы наружу. Снапшот версии валиден по построению, сбой здесь — 500.
	if pf.ParseErr != nil {
		return domain.ConsentDocument{}, fmt.Errorf("parse published schema of %s: %v", slug, pf.ParseErr)
	}
	// pf.Title уже разрешён так же, как заголовок на самой форме: блок заголовка, иначе колонка.
	return domain.RenderConsentDocument(kind, rev.Settings, rev.Template, consentDocInput(pf.Parsed, pf.Title))
}

// consentOperatorsLimit — сколько наборов реквизитов отдаёт подсказка.
const consentOperatorsLimit = 20

// ConsentOperators — список реквизитов пространства для подсказки в разделе
// «Персональные данные», свежие первыми.
func (s *Service) ConsentOperators(ctx context.Context, userID, workspaceID uuid.UUID) ([]ConsentOperatorItem, error) {
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionFormRead); err != nil {
		return nil, err
	}
	return s.repo.ListConsentOperators(ctx, s.db, workspaceID, consentOperatorsLimit)
}

// DeleteConsentOperator убирает набор из списка пространства. Формы и их ревизии хранят
// свою копию и не меняются.
func (s *Service) DeleteConsentOperator(ctx context.Context, userID, operatorID uuid.UUID) error {
	workspaceID, err := s.repo.GetConsentOperatorWorkspace(ctx, s.db, operatorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionFormWrite); err != nil {
		return err
	}
	n, err := s.repo.DeleteConsentOperator(ctx, s.db, operatorID, workspaceID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}
