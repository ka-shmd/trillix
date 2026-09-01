package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/ai"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
)

// Сборка формы по описанию автора (фаза 26). Здесь живёт только связка: право,
// квота, инструкция, вызов, разбор, создание черновика. Что модель вправе
// предлагать и во что это разворачивается — domain/formplan.go; как устроен вызов
// — internal/ai.

const (
	// MaxPromptLen — потолок описания в рунах. Просторно для «анкета записи в
	// барбершоп: имя, телефон, мастер, дата», тесно для попытки прислать модели
	// чужой текст на пересказ.
	MaxPromptLen = 1000
	// planTokens — потолок ответа модели. Считается вместе с её рассуждением
	// (internal/ai), поэтому кратно больше самого плана: тесный потолок даёт
	// пустой ответ, а не короткую форму.
	planTokens = 8000
)

// Generator — модель, собирающая план формы. Интерфейс объявлен здесь, на стороне
// потребителя: forms знает, ЧТО спрашивает, и не обязан знать, кто отвечает.
type Generator interface {
	Generate(ctx context.Context, req ai.Request) (json.RawMessage, error)
}

// WithAI подключает модель (тот же приём, что WithFiles и WithSecret). Не
// подключена — генерации на контуре нет, и ручка отвечает 404, как непрописанный
// провайдер OAuth: контур без провайдера обязан работать.
func (s *Service) WithAI(g Generator) *Service {
	s.ai = g
	return s
}

// Generate собирает черновик формы по описанию автора.
//
// Порядок ходов важен и выбран так: право → квота → модель → списание → создание
// формы. Списание стоит ПЕРЕД созданием, потому что провалиться может и оно, а
// форма, созданная бесплатно из-за сбоя счётчика, — это дыра в квоте; вызов же к
// этому моменту уже сделан и оплачен нами в любом случае.
func (s *Service) Generate(ctx context.Context, userID uuid.UUID, prompt string, workspaceID *uuid.UUID) (Form, error) {
	if s.ai == nil {
		return Form{}, domain.ErrNotFound
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return Form{}, fmt.Errorf("%w: опишите форму словами", domain.ErrValidation)
	}
	if utf8.RuneCountInString(prompt) > MaxPromptLen {
		return Form{}, fmt.Errorf("%w: описание длиннее %d символов", domain.ErrValidation, MaxPromptLen)
	}

	wsID, err := s.resolveWorkspace(ctx, userID, workspaceID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	quota, err := s.plans.CheckWorkspace(ctx, wsID, entitlements.AIGenerations)
	if err != nil {
		return Form{}, err
	}
	if !quota.Allowed {
		return Form{}, domain.ErrPlanRequired
	}

	plan, err := s.askForPlan(ctx, prompt)
	if err != nil {
		return Form{}, err
	}
	schema, err := domain.ExpandPlan(plan)
	if err != nil {
		// Сюда попасть можно только если ExpandPlan строже проверки, которой
		// пользовался цикл починки, — то есть при расхождении внутри домена.
		return Form{}, fmt.Errorf("expand plan: %w", err)
	}
	doc, err := json.Marshal(schema)
	if err != nil {
		return Form{}, fmt.Errorf("marshal generated schema: %w", err)
	}

	if err := s.plans.ConsumeAIGeneration(ctx, wsID, quota.Period); err != nil {
		return Form{}, err
	}

	title := strings.TrimSpace(plan.Title)
	if title == "" {
		title = defaultFormTitle
	}
	form, err := s.repo.CreateFormWithSchema(ctx, s.db, domain.NewID(), wsID, title, domain.NewSlug(), nil, doc)
	if err != nil {
		return Form{}, err
	}
	return form, nil
}

// askForPlan — вызов модели с одной попыткой починки и разбор ответа.
func (s *Service) askForPlan(ctx context.Context, prompt string) (domain.FormPlan, error) {
	req := ai.Request{
		System:     planInstructions(),
		User:       prompt,
		SchemaName: "form_plan",
		Schema:     domain.PlanJSONSchema(),
		MaxTokens:  planTokens,
	}
	check := func(raw json.RawMessage) error {
		plan, err := domain.ParsePlan(raw)
		if err != nil {
			return err
		}
		return domain.ValidatePlan(plan)
	}

	raw, err := ai.AskJSON(ctx, s.ai, req, check)
	if err != nil {
		return domain.FormPlan{}, generationError(err)
	}
	// Ответ уже прошёл check выше — здесь остаётся только разобрать его вторично.
	return domain.ParsePlan(raw)
}

// generationError переводит отказ подсистемы в доменный.
//
// Провайдер и невыносимый ответ модели дают 503, а не 422: 422 сказал бы автору,
// что не так с его описанием, — а не так с нашей стороной, и правильное действие
// у него одно, попробовать ещё раз. 404 у выключенного провайдера — то же
// поведение, что у непрописанного провайдера OAuth: ручки на этом контуре нет.
func generationError(err error) error {
	switch {
	case errors.Is(err, ai.ErrDisabled):
		return domain.ErrNotFound
	case errors.Is(err, ai.ErrRejected):
		return fmt.Errorf("%w: не удалось собрать форму по этому описанию, попробуйте сформулировать иначе", domain.ErrUnavailable)
	case errors.Is(err, ai.ErrProvider), errors.Is(err, ai.ErrEmptyAnswer):
		return fmt.Errorf("%w: модель сейчас не отвечает, попробуйте ещё раз", domain.ErrUnavailable)
	default:
		return err
	}
}

// planInstructions — системная инструкция модели. Перечень типов собирается из
// реестра (domain.PlanTypes), а не пишется здесь руками: иначе новый тип вопроса
// пришлось бы вспоминать в двух местах, и одно из них молчало бы.
func planInstructions() string {
	var b strings.Builder
	b.WriteString("Ты собираешь план формы-анкеты по описанию автора. Отвечай только JSON по схеме ответа.\n\nТипы пунктов (поле type):\n")
	for _, d := range domain.PlanTypes() {
		fmt.Fprintf(&b, "- %s — %s: %s\n", d.Type, d.Title, d.Hint)
	}
	b.WriteString(`
Правила:
- title — короткий заголовок формы, без слова «форма».
- items — по одному пункту на вопрос, в порядке показа.
- text — то, что увидит респондент: подпись вопроса; у consent это текст согласия; у text и heading — сам текст; у page_break — пустая строка.
- options заполняй только у single_choice, dropdown и multi_choice, минимум два варианта; у остальных типов — пустой массив.
- scaleMin и scaleMax задавай только у scale (в пределах 0..10); у остальных типов — нули. Диапазон не повторяй словами в подписи: респондент видит его на самой шкале.
- required ставь там, без чего заявка бессмысленна.
- Не добавляй вопросов, о которых не просили, кроме очевидно необходимых контактов.
- Язык формы — язык описания автора.
- Отвечай сразу планом: структура простая, длинные рассуждения ей не нужны.`)
	return b.String()
}
