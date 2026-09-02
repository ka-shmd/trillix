package forms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/ai"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
)

// Разговор с ассистентом над формой (фаза 26, слайс E). Здесь связка: право,
// квота, инструкция, вызов, разбор намерения, применение правки. Что модель вправе
// предлагать и как правка ложится на документ — `domain/formplan.go` и
// `domain/formedit.go`; как устроен вызов — `internal/ai`.

const (
	// MaxChatMessageLen — потолок одной реплики автора, в рунах. Зеркало на фронте.
	MaxChatMessageLen = 1000
	// MaxChatHistory — сколько прошлых реплик едет в модель. Потолок обязателен, а
	// не желателен: контекст растёт линейно, и без него каждое следующее сообщение
	// разговора дороже и медленнее предыдущего (ADR §10).
	MaxChatHistory = 10
	// MaxChatReplyLen — потолок ответа ассистента, в рунах. Длиннее — режем: это
	// косметика, и гонять ради неё вторую попытку модели дороже самой проблемы.
	MaxChatReplyLen = 2000
	// chatTokens — потолок ответа модели. Меньше, чем у сборки с нуля: правка — это
	// несколько операций, а не документ целиком.
	chatTokens = 4000
)

// ChatTurn — реплика разговора, пришедшая от клиента. История живёт на клиенте
// (ADR §10), поэтому её присылают с каждым запросом.
type ChatTurn struct {
	Assistant bool
	Text      string
}

// ChatResult — что ассистент сделал.
type ChatResult struct {
	Reply string
	// Schema — новый документ формы, если правка состоялась; nil — ассистент только
	// ответил словами.
	//
	// Схема ВОЗВРАЩАЕТСЯ, а не сохраняется: черновик пишет автосейв полотна своим
	// путём с оптимистичной блокировкой, и второй писатель в базу означал бы гонку
	// с ним на ровном месте. Ручка чата в базу не пишет вовсе.
	Schema json.RawMessage
}

// chatIntent — ответ модели: намерение плюс правка.
type chatIntent struct {
	Action string `json:"action"`
	Reply  string `json:"reply"`
	domain.ChatEdit
	Design domain.ChatDesign `json:"design"`
}

// Chat — одна реплика разговора.
//
// Документ приходит ОТ КЛИЕНТА, а не читается из базы: полотно у автора может быть
// свежее сохранённого (автосейв ходит с задержкой), и править надо то, что человек
// видит. Права при этом проверяются как везде — по форме из адреса, а не по
// присланному телу.
func (s *Service) Chat(
	ctx context.Context, userID, formID uuid.UUID,
	message string, history []ChatTurn, rawSchema json.RawMessage,
) (ChatResult, error) {
	if s.ai == nil {
		return ChatResult{}, domain.ErrNotFound
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return ChatResult{}, fmt.Errorf("%w: скажите, что сделать с формой", domain.ErrValidation)
	}
	if utf8.RuneCountInString(message) > MaxChatMessageLen {
		return ChatResult{}, fmt.Errorf("%w: сообщение длиннее %d символов", domain.ErrValidation, MaxChatMessageLen)
	}

	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return ChatResult{}, err
	}
	if len(rawSchema) == 0 {
		rawSchema = form.DraftSchema
	}
	schema, err := domain.ValidateSchema(rawSchema)
	if err != nil {
		return ChatResult{}, err
	}

	quota, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.AIGenerations)
	if err != nil {
		return ChatResult{}, err
	}
	if !quota.Allowed {
		return ChatResult{}, domain.ErrPlanRequired
	}

	// Тариф на оформление спрашивается ДО вызова: модель должна знать, что ей
	// позволено, и объяснить отказ словами автора, а не получить сухую 402 после.
	design, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.FormDesignCustom)
	if err != nil {
		return ChatResult{}, err
	}
	paidDesign := design.Allowed

	intent, err := s.askAssistant(ctx, message, history, schema, paidDesign)
	if err != nil {
		return ChatResult{}, err
	}

	result := ChatResult{Reply: trimRunes(intent.Reply, MaxChatReplyLen)}
	var updated domain.FormSchema
	switch intent.Action {
	case domain.ActionEdit:
		updated, err = domain.ApplyChatEdit(schema, intent.ChatEdit)
	case domain.ActionDesign:
		// ГЕЙТ СТОИТ ЗДЕСЬ, а не на публикации: покрасить форму, чтобы автор упёрся
		// в 402 при попытке её опубликовать, — худший из вариантов. Модели про тариф
		// сказано в инструкции, но замер показал, что она это указание нарушает,
		// поэтому решает всё равно сервер.
		//
		// ПЛАТНОЕ ОТСЕКАЕТСЯ, А БЕСПЛАТНОЕ ДЕЛАЕТСЯ: «сделай тёмной и покрась в
		// синий» на бесплатном тарифе даёт тёмную форму и честную фразу про цвета —
		// отказать целиком значило бы не сделать и того, что человеку положено.
		// Ответ ассистента при этом ЗАМЕНЯЕТСЯ нашим: свой он написал про обе
		// правки, и оставить его значило бы соврать.
		patch := intent.Design
		if paid := domain.ChatDesignPaid(patch); len(paid) > 0 && !paidDesign {
			patch = domain.ChatDesignFree(patch)
			if patch.Empty() {
				return ChatResult{}, fmt.Errorf("%w: %s — платная возможность, на этом тарифе доступна только тема",
					domain.ErrPlanRequired, strings.Join(paid, " и "))
			}
			result.Reply = fmt.Sprintf("Поменял тему. %s — платная возможность, на этом тарифе недоступна.",
				capitalize(strings.Join(paid, " и ")))
		}
		updated, err = domain.ApplyChatDesign(schema, patch)
	}
	if err != nil {
		// Сюда попасть можно только при расхождении внутри домена: тот же разбор уже
		// прошёл проверкой цикла починки. Поэтому %v, а не %w: это наша поломка, и
		// показывать автору её текст («design.palette.canvas: нужен #rrggbb…») —
		// значит выдавать внутренности за объяснение.
		return ChatResult{}, fmt.Errorf("apply chat intent %q: %v", intent.Action, err)
	}
	if intent.Action != domain.ActionAnswer {
		doc, err := json.Marshal(updated)
		if err != nil {
			return ChatResult{}, fmt.Errorf("marshal edited schema: %w", err)
		}
		// Страховка на выходе: кабинету не отдаётся документ, который отверг бы наш
		// же валидатор. Сохранит его автосейв, и там проверка стоит своя, но узнать
		// о расхождении в момент сохранения — значит узнать поздно.
		if _, err := domain.ValidateSchema(doc); err != nil {
			return ChatResult{}, fmt.Errorf("собранный документ не проходит проверку: %w", err)
		}
		result.Schema = doc
	}

	// Списание — ПОСЛЕ удачи и один раз на сообщение автора: починка негодного
	// ответа вторым вызовом это наша реакция на свой дефект (ADR §10).
	if err := s.plans.ConsumeAIGeneration(ctx, form.WorkspaceID, quota.Period); err != nil {
		return ChatResult{}, err
	}
	return result, nil
}

// askAssistant — вызов модели с одной попыткой починки и разбор намерения.
func (s *Service) askAssistant(
	ctx context.Context, message string, history []ChatTurn, schema domain.FormSchema, paidDesign bool,
) (chatIntent, error) {
	req := ai.Request{
		System:     chatInstructions(domain.ProjectForm(schema), paidDesign),
		User:       message,
		History:    turns(history),
		SchemaName: "form_chat",
		Schema:     domain.ChatJSONSchema(),
		MaxTokens:  chatTokens,
	}

	check := func(raw json.RawMessage) error {
		intent, err := parseIntent(raw)
		if err != nil {
			return err
		}
		// Правка проверяется ПРИМЕНЕНИЕМ — и вопросов, и оформления: у них нет
		// отдельного валидатора, а второй набор правил означал бы второй источник
		// истины. Документ отсюда выбрасывается, начисто применяем ещё раз.
		//
		// МИНА: проверять надо ОБА действия. Пока здесь стояла только правка
		// вопросов, негодное оформление (цвет заглавными буквами) доживало до
		// применения и вылезало пятисоткой вместо второй попытки модели.
		switch intent.Action {
		case domain.ActionEdit:
			_, err = domain.ApplyChatEdit(schema, intent.ChatEdit)
		case domain.ActionDesign:
			_, err = domain.ApplyChatDesign(schema, intent.Design)
		}
		return err
	}

	raw, err := ai.AskJSON(ctx, s.ai, req, check)
	if err != nil {
		return chatIntent{}, generationError(err)
	}
	return parseIntent(raw)
}

// parseIntent разбирает ответ модели строго: лишние поля отвергаются, как и в
// схеме формы.
func parseIntent(raw json.RawMessage) (chatIntent, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()

	var intent chatIntent
	if err := dec.Decode(&intent); err != nil {
		return chatIntent{}, fmt.Errorf("%w: не удалось разобрать ответ: %v", domain.ErrValidation, err)
	}
	switch intent.Action {
	case domain.ActionEdit:
		if intent.Empty() {
			return chatIntent{}, fmt.Errorf("%w: заявлена правка формы, но ни одного изменения не названо; "+
				"если менять нечего, отвечай действием %q", domain.ErrValidation, domain.ActionAnswer)
		}
		if !intent.Design.Empty() {
			return chatIntent{}, fmt.Errorf("%w: действие %q оформления не касается; для вида формы возьми %q",
				domain.ErrValidation, domain.ActionEdit, domain.ActionDesign)
		}
	case domain.ActionDesign:
		if intent.Design.Empty() {
			return chatIntent{}, fmt.Errorf("%w: заявлено оформление, но ни тема, ни шрифт, ни цвета не названы",
				domain.ErrValidation)
		}
		if !intent.Empty() {
			return chatIntent{}, fmt.Errorf("%w: действие %q вопросов не трогает; чтобы поправить их, возьми %q",
				domain.ErrValidation, domain.ActionDesign, domain.ActionEdit)
		}
	case domain.ActionAnswer:
		if !intent.Empty() || !intent.Design.Empty() {
			return chatIntent{}, fmt.Errorf("%w: действие %q форму не правит; чтобы поправить, возьми %q или %q",
				domain.ErrValidation, domain.ActionAnswer, domain.ActionEdit, domain.ActionDesign)
		}
	default:
		return chatIntent{}, fmt.Errorf("%w: неизвестное действие %q; возможны: %s, %s, %s",
			domain.ErrValidation, intent.Action, domain.ActionEdit, domain.ActionAnswer, domain.ActionDesign)
	}
	if strings.TrimSpace(intent.Reply) == "" {
		return chatIntent{}, fmt.Errorf("%w: скажи словами, что сделал: поле reply пустое", domain.ErrValidation)
	}
	return intent, nil
}

// turns — история в том виде, в каком её понимает клиент модели. Берутся ПОСЛЕДНИЕ
// MaxChatHistory реплик: старое дешевле забыть, чем возить в каждом запросе.
func turns(history []ChatTurn) []ai.Turn {
	if len(history) > MaxChatHistory {
		history = history[len(history)-MaxChatHistory:]
	}
	out := make([]ai.Turn, 0, len(history))
	for _, h := range history {
		text := trimRunes(strings.TrimSpace(h.Text), MaxChatReplyLen)
		if text == "" {
			continue
		}
		out = append(out, ai.Turn{Assistant: h.Assistant, Text: text})
	}
	return out
}

// capitalize поднимает первую букву: перечень платных настроек приходит из домена
// строчными («цвета», «шрифт»), а начинать им предложение.
func capitalize(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return string(unicode.ToUpper(r[0])) + string(r[1:])
}

func trimRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// chatInstructions — системная инструкция ассистента. Перечень типов и правила
// пунктов берутся оттуда же, откуда их берёт сборка с нуля (реестр), а форма
// приезжает проекцией — тем же словарём, которым модель отвечает.
func chatInstructions(form domain.ChatForm, paidDesign bool) string {
	var b strings.Builder
	b.WriteString(`Ты — помощник в редакторе форм. Отвечай только JSON по схеме ответа.

Два действия:
- "` + domain.ActionEdit + `" — изменить форму: добавить, заменить, убрать, переставить пункты, сменить заголовок. В reply одной фразой скажи, что сделал.
- "` + domain.ActionDesign + `" — изменить ВИД формы: тема, шрифт, цвет акцента, цвет страницы. Вопросов это действие не трогает.
- "` + domain.ActionAnswer + `" — ответить словами о самой форме, ничего не меняя. Списки правок и оформление при этом пустые.

ГЛАВНОЕ: форму меняют ТОЛЬКО списки add, update, remove, move и поле title. Что не попало в них — не произошло. Написать в reply «добавил вопросы» и оставить add пустым — ошибка.

reply — это то, что автор прочитает в чате. Никогда не упоминай в нём JSON, схему ответа, поля, действия и прочее своё устройство: автор их не видит.
Плохо: «не могу изменить это через JSON». Хорошо: «Скругление полей меняется в панели оформления».

Как собрать форму с нуля (форма ниже пустая): дай title и по одному пункту в add на КАЖДЫЙ вопрос, в том порядке, в каком они должны идти, у всех after — пустая строка. Пример ответа на «анкета обратной связи: оценка и комментарий»:
{"action":"` + domain.ActionEdit + `","reply":"Собрал форму из двух вопросов.","title":"Обратная связь",
 "add":[{"after":"","item":{"type":"scale","text":"Как вы оцениваете нашу работу?","required":true,"options":[],"scaleMin":1,"scaleMax":5}},
        {"after":"","item":{"type":"long_text","text":"Что стоит улучшить?","required":false,"options":[],"scaleMin":0,"scaleMax":0}}],
 "update":[],"remove":[],"move":[]}

Как править существующую:
- Ключи пунктов (q1, q2, …) бери только из формы ниже. У новых пунктов ключа нет — сослаться на них в этой же правке нельзя.
- add.after и move.after — ключ пункта, ПОСЛЕ которого встать; пустая строка — в начало формы. Несколько добавлений с одним after встают в том порядке, в каком перечислены.
- update заменяет пункт целиком: пришли его новое содержимое, включая варианты.
- title — новый заголовок формы; пустая строка — не менять.
- Делай ровно то, о чём попросили: остальные пункты не трогай.

`)
	b.WriteString(planTypesBlock())
	b.WriteString("\n" + planItemRules() + "\n")
	b.WriteString("\nТекущая форма:\n")
	doc, err := json.MarshalIndent(form, "", " ")
	if err == nil {
		b.Write(doc)
	}
	fmt.Fprintf(&b, "\n\nОформление (действие %s): в поле design заполняй только то, что просят, остальное — пустая строка (width — ноль). "+
		"theme — %s; font — один из: %s; accent и canvas — цвет в формате #rrggbb (акцент и фон страницы); "+
		"width — ширина колонки формы в px, от %d до %d.",
		domain.ActionDesign, strings.Join(domain.DesignThemes(), " или "),
		strings.Join(domain.DesignFonts(), ", "), domain.MinColumn, domain.MaxColumn)
	b.WriteString(" Больше в оформлении ты не умеешь ничего: скругления, отступы, плотность, вид кнопки и свой CSS правятся панелью оформления. " +
		"Просят такое — отвечай действием " + domain.ActionAnswer + " и скажи, где это меняется; повторять прошлую правку вместо ответа нельзя.")
	if paidDesign {
		b.WriteString(" Тариф автора позволяет всё перечисленное.")
	} else {
		b.WriteString(" ВАЖНО: на тарифе автора бесплатна только тема; шрифт и цвета — платные. " +
			"Попросят цвет или шрифт — не меняй их, а действием " + domain.ActionAnswer + " объясни, что это платная возможность.")
	}
	b.WriteString(`

Чего ты не знаешь: ответов респондентов и статистики формы у тебя нет — только сама форма. Спросят о них — так и скажи.`)
	return b.String()
}
