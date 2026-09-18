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
	//
	// ЗАПАС ТРОЙНОЙ, И ЭТО ПРОВЕРЕНО: замер 2026-09-02 на самом длинном, что тут
	// бывает (сборка формы из пяти вопросов с оформлением, прямо в разговоре), —
	// 818–1273 токена. Упёршийся в потолок ответ означает не тесноту, а вырождение
	// модели (`ai.ErrTruncated`), и поднимать потолок в ответ на него бесполезно:
	// пробельный забег съест любой.
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
	// PlanRequired — часть просьбы не выполнена из-за тарифа. Флаг, а не разбор
	// текста ответа на клиенте: по нему кабинет открывает рекламный оверлей тарифа
	// (тот же, что у прочих платных возможностей), а гадать по словам ассистента,
	// упёрся ли автор в тариф, значило бы читать прозу модели программой.
	PlanRequired bool
}

// chatIntent — ответ модели: намерение плюс правка.
type chatIntent struct {
	Action string `json:"action"`
	Reply  string `json:"reply"`
	// PlanBlocked — модель сама не сделала часть просьбы, потому что тариф её не
	// пускает. Спрашиваем ПОЛЕМ, а не читаем это из reply: отказ ассистента словами
	// («цвета доступны на платном тарифе») — обычный удачный ответ, и без флага
	// кабинету нечем отличить его от любого другого, кроме разбора прозы модели.
	PlanBlocked bool `json:"planBlocked"`
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
		// ТЕКСТ ОБЯЗАТЕЛЕН: 402 из этой ручки бывает двух родов — кончились сообщения
		// и упёрлись в платную настройку вида, — а код конверта у них один. Пока отказ
		// по квоте был безымянным, кабинету оставалось печатать про исчерпанную квоту
		// на любой из них, и автор с нулём израсходованных сообщений читал, что они
		// кончились.
		return ChatResult{}, fmt.Errorf(
			"%w: сообщения к ассистенту на этом тарифе кончились — счётчик обнулится первого числа",
			domain.ErrPlanRequired)
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

	// Слово модели о тарифе принимается, только когда тариф и правда закрыт: на
	// открытом плане чату гейтить нечего, и «не сделал из-за тарифа» там означало бы
	// предложить автору купить то, что у него уже куплено.
	result := ChatResult{
		Reply:        trimRunes(intent.Reply, MaxChatReplyLen),
		PlanRequired: intent.PlanBlocked && !paidDesign,
	}

	// ГЕЙТ ОФОРМЛЕНИЯ СТОИТ ЗДЕСЬ, а не на публикации: покрасить форму, чтобы автор
	// упёрся в 402 при попытке её опубликовать, — худший из вариантов. Модели про
	// тариф сказано в инструкции, но замер показал, что она это указание нарушает,
	// поэтому решает всё равно сервер.
	//
	// ПЛАТНОЕ ОТСЕКАЕТСЯ, А БЕСПЛАТНОЕ ДЕЛАЕТСЯ: «сделай тёмной и покрась в синий»
	// на бесплатном тарифе даёт тёмную форму и честную фразу про цвета — отказать
	// целиком значило бы не сделать и того, что человеку положено. Ответ ассистента
	// при этом ЗАМЕНЯЕТСЯ нашим: свой он написал про обе правки.
	if paid := domain.ChatDesignPaid(intent.Design); len(paid) > 0 && !paidDesign {
		intent.Design = domain.ChatDesignFree(intent.Design)
		if intent.Design.Empty() && intent.Empty() {
			return ChatResult{}, fmt.Errorf("%w: %s — платная возможность, на этом тарифе она недоступна",
				domain.ErrPlanRequired, strings.Join(paid, " и "))
		}
		// Ответ ассистента ЗАМЕНЯЕТСЯ целиком, а не дополняется: свой он написал про
		// всю просьбу разом («сделал тёмной и покрасил в синий»), и приписка «цвета
		// недоступны» рядом с этой фразой противоречила бы ей же.
		result.Reply = paidRefusalReply(intent, paid)
		result.PlanRequired = true
	}

	updated, err := applyIntent(schema, intent)
	if err != nil {
		// Сюда попасть можно только при расхождении внутри домена: тот же разбор уже
		// прошёл проверкой цикла починки. Поэтому %v, а не %w: это наша поломка, и
		// показывать автору её текст («design.palette.canvas: нужен #rrggbb…») —
		// значит выдавать внутренности за объяснение.
		return ChatResult{}, fmt.Errorf("apply chat intent %q: %v", intent.Action, err)
	}
	// Документ возвращается, только если он изменился: класть нетронутый значило бы
	// заставлять кабинет сравнивать его с тем, что у него уже есть.
	if !intent.Empty() || !intent.Design.Empty() {
		doc, err := json.Marshal(updated)
		if err != nil {
			return ChatResult{}, fmt.Errorf("marshal edited schema: %w", err)
		}
		// Страховка на выходе: кабинету не отдаётся документ, который отверг бы наш
		// же валидатор. Сохранит его автосейв, и там проверка стоит своя, но узнать
		// о расхождении в момент сохранения — значит узнать поздно.
		if _, err := domain.ValidateSchema(doc); err != nil {
			// %v, а не %w, и без доменного сентинела: сюда попадают только НАШИ
			// расхождения (правка собрала документ, который отвергает наш же
			// валидатор), и автору незачем читать «тип "short_text" не принимает
			// файлы» — это отчёт для нас, а не объяснение для него. Ошибка уходит в
			// лог целиком и отдаётся как внутренняя.
			return ChatResult{}, fmt.Errorf("chat: собранный документ не проходит проверку: %v", err)
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
		_, err = applyIntent(schema, intent)
		return err
	}

	raw, err := ai.AskJSON(ctx, s.ai, req, check)
	if err != nil {
		return chatIntent{}, generationError(ctx, err)
	}
	return parseIntent(raw)
}

// paidRefusalReply — что ассистент скажет, когда часть правки вида отсечена
// тарифом. Собирается из того, что мы РЕАЛЬНО применили, а не из слов модели.
func paidRefusalReply(intent chatIntent, paid []string) string {
	var did []string
	if !intent.Empty() {
		did = append(did, "правки вопросов применил")
	}
	if !intent.Design.Empty() {
		did = append(did, "вид поменял в доступной части")
	}
	return fmt.Sprintf("%s. %s — платная возможность, на этом тарифе недоступна.",
		capitalize(strings.Join(did, ", ")), capitalize(strings.Join(paid, ", ")))
}

// applyIntent накладывает обе части ответа — правку вопросов и правку вида — на
// документ. Одна функция на проверку и на применение: разойдись они, проверка цикла
// починки перестала бы ловить то, на чём падает применение (так и случилось с
// оформлением, пока проверка смотрела только на вопросы).
func applyIntent(s domain.FormSchema, intent chatIntent) (domain.FormSchema, error) {
	var err error
	if !intent.Empty() {
		if s, err = domain.ApplyChatEdit(s, intent.ChatEdit); err != nil {
			return domain.FormSchema{}, err
		}
	}
	if !intent.Design.Empty() {
		if s, err = domain.ApplyChatDesign(s, intent.Design); err != nil {
			return domain.FormSchema{}, err
		}
	}
	return s, nil
}

// parseIntent разбирает ответ модели строго: лишние поля отвергаются, как и в
// схеме формы.
func parseIntent(raw json.RawMessage) (chatIntent, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()

	// Пустое оформление ЗАРАНЕЕ: у числовых полей «не трогать» это -1, а нулевое
	// значение структуры означало бы «поставить ширину 0». Без этой строки любой
	// ответ без блока design читался бы как правка оформления.
	intent := chatIntent{Design: domain.ChatDesignEmpty()}
	if err := dec.Decode(&intent); err != nil {
		return chatIntent{}, fmt.Errorf("%w: не удалось разобрать ответ: %v", domain.ErrValidation, err)
	}
	switch intent.Action {
	case domain.ActionEdit:
		if intent.Empty() && intent.Design.Empty() {
			return chatIntent{}, fmt.Errorf("%w: заявлена правка формы, но ни одного изменения не названо; "+
				"если менять нечего, отвечай действием %q", domain.ErrValidation, domain.ActionAnswer)
		}
	case domain.ActionAnswer:
		if !intent.Empty() || !intent.Design.Empty() {
			return chatIntent{}, fmt.Errorf("%w: действие %q форму не правит; чтобы поправить, возьми %q",
				domain.ErrValidation, domain.ActionAnswer, domain.ActionEdit)
		}
	default:
		return chatIntent{}, fmt.Errorf("%w: неизвестное действие %q; возможны: %s, %s",
			domain.ErrValidation, intent.Action, domain.ActionEdit, domain.ActionAnswer)
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
- "` + domain.ActionEdit + `" — изменить форму: её пункты (add, update, remove, move), заголовок (title) и вид (design). Просьба часто про то и другое сразу («собери форму и сделай её яркой») — тогда в ОДНОМ ответе заполняй и пункты, и design.
- "` + domain.ActionAnswer + `" — ответить словами, ничего не меняя: вопрос о самой форме или просьба, из которой нельзя выполнить ничего. Списки правок и оформление при этом пустые.

ГЛАВНОЕ: форму меняют ТОЛЬКО списки add, update, remove, move и поля title и design. Что не попало в них — не произошло. Написать в reply «добавил вопросы» и оставить add пустым — ошибка.

ВЫПОЛНЯЙ ПРОСЬБУ ЦЕЛИКОМ. Если какую-то её часть сделать нечем (см. «Чего у тебя нет»), сделай ВСЁ ОСТАЛЬНОЕ, а в reply одной фразой скажи, чего не сделал и где это делается. Отказаться от всей просьбы из-за одной недоступной части — ошибка.

reply — то, что автор прочитает в чате: коротко, что ты сделал. Он обязан СООТВЕТСТВОВАТЬ заполненным полям: не приписывай себе того, чего в них нет, и не отрицай того, что в них есть. О том, чего ты не умеешь, пиши, только если об этом просили. Никогда не упоминай JSON, схему ответа, поля, действия и прочее своё устройство: автор их не видит.
Плохо: «не могу изменить это через JSON». Хорошо: «Обложку добавьте кнопкой «Добавить обложку» над заголовком формы».

planBlocked — true, если часть просьбы ты не выполнил из-за тарифа автора (см. ниже), иначе false. Кабинет покажет по нему предложение тарифа; в reply про тариф всё равно скажи словами.

Как собрать форму с нуля (в форме ниже нет пунктов). «Сделай», «собери», «создай» форму — это ВСЕГДА вопросы: дай title и по одному пункту в add на КАЖДЫЙ вопрос, в том порядке, в каком они должны идти, у всех after — пустая строка. Если в просьбе есть и пожелание к виду («красивая», «яркая», «разноцветная», «в розовых тонах», «с декором») — это ЕЩЁ И design: подбери тему, шрифт и цвета сам; размытое пожелание — повод выбрать самому, а не отказать. Пример ответа на «анкета обратной связи в тёмных тонах: оценка и комментарий»:
{"action":"` + domain.ActionEdit + `","reply":"Собрал форму из двух вопросов и сделал её тёмной.","planBlocked":false,"title":{"text":"Обратная связь","bold":false,"color":"","bg":""},
 "add":[{"after":"","item":{"type":"scale","text":"Как вы оцениваете нашу работу?","required":true,"options":[],"scaleMin":1,"scaleMax":5}},
        {"after":"","item":{"type":"long_text","text":"Что стоит улучшить?","required":false,"options":[],"scaleMin":0,"scaleMax":0}}],
 "update":[],"remove":[],"move":[],
 "design":{"theme":"dark", …остальные строки пустые, остальные числа ` + fmt.Sprint(domain.ChatDesignKeep) + `}}

Как править существующую:
- Ключи пунктов (q1, q2, …) бери только из формы ниже. У новых пунктов ключа нет — сослаться на них в этой же правке нельзя.
- add.after и move.after — ключ пункта, ПОСЛЕ которого встать; пустая строка — в начало формы. Несколько добавлений с одним after встают в том порядке, в каком перечислены.
- update заменяет пункт целиком: пришли его новое содержимое, включая варианты.
- title.text — новый заголовок формы; пустая строка — не менять. У заголовка есть своё оформление: title.bold, title.color, title.bg. Поля title описывают ЖЕЛАЕМОЕ состояние заголовка целиком: правишь что-то другое — повтори его нынешние оформление и текст из формы ниже, иначе снимешь их с него.
- ЖИРНОСТЬ ПОДПИСИ И ЕЁ ЦВЕТА — ЭТО ПРАВКА ПУНКТА, а не оформление формы: «сделай все заголовки жирными» = update на каждый пункт с bold: true и прежними text, type, options. «Выдели заголовок формы фоном» = title с полем bg.
- Делай ровно то, о чём попросили: остальные пункты не трогай.

`)
	b.WriteString(planTypesBlock())
	b.WriteString("\n" + planItemRules() + "\n")
	fmt.Fprintf(&b, `
Оформление (поле design). Заполняй ТОЛЬКО то, о чём просят: остальные строки — пустые, остальные числа — %d («не трогать»). Ноль у числа значит ноль, а не «не трогать».
- theme: %s
- font: %s
- цвета в формате #rrggbb: accent (акцент), canvas (фон страницы), textColor (текст), buttonColor (кнопка)
- width — ширина колонки формы в px (%d–%d); fontSize — базовый кегль (%d–%d)
- density — плотность (%s); align — выравнивание текста (%s)
- radius — скругление полей в px (%d–%d); borderWidth — толщина края поля в px (%d–%d); outline — чем нарисован контур поля (%s)
- buttonVariant (%s), buttonWidth (%s), buttonAlign (%s), buttonRadius — скругление кнопки в px (%d–%d)

Декор, который у тебя есть: цвета страницы, акцента и кнопки, шрифт, скругления и контур полей, цвет текста и фона у подписей и у разделов (color и bg пункта), разделы (heading) между группами вопросов.

Чего у тебя нет — и где это делает автор:
- обложка и логотип — кнопки «Добавить обложку» и «Добавить логотип» над заголовком формы на полотне (видны при наведении) или шторка «Оформление», раздел «Лэйаут»;
- картинки внутри формы — на полотне, блок «Картинка» из меню «+»;
- свой CSS, отступы и размеры кнопки в деталях — шторка «Оформление» (кнопка в шапке редактора);
- условная логика — на полотне.
Повторять прошлую правку вместо этого нельзя.`,
		domain.ChatDesignKeep,
		strings.Join(domain.DesignThemes(), " или "), strings.Join(domain.DesignFonts(), ", "),
		domain.MinColumn, domain.MaxColumn, domain.MinFontSize, domain.MaxFontSize,
		strings.Join(domain.DesignDensities(), ", "), strings.Join(domain.DesignAligns(), ", "),
		domain.MinRadius, domain.MaxRadius, domain.MinBorderWidth, domain.MaxBorderWidth,
		strings.Join(domain.DesignOutlines(), ", "),
		strings.Join(domain.DesignButtonVariants(), ", "), strings.Join(domain.DesignButtonWidths(), ", "),
		strings.Join(domain.DesignButtonAligns(), ", "), domain.MinRadius, domain.MaxRadius)
	if paidDesign {
		b.WriteString("\n\nТариф автора позволяет всё перечисленное в оформлении, planBlocked всегда false.")
	} else {
		b.WriteString("\n\nВАЖНО: тариф автора ограничивает оформление. Бесплатны только theme, borderWidth и buttonRadius; " +
			"остальные поля design платные — не заполняй их. " +
			"ОСТАЛЬНУЮ ЧАСТЬ ПРОСЬБЫ ПРИ ЭТОМ ВЫПОЛНИ ЦЕЛИКОМ: собирать и править вопросы тариф не мешает, " +
			"а про платное скажи словами в reply. Действие " + domain.ActionAnswer +
			" бери, только если кроме платного оформления не просили ничего." +
			" Не сделал что-то из просьбы из-за тарифа — ставь planBlocked: true.")
	}
	b.WriteString(`

Чего ты не знаешь: ответов респондентов и статистики формы у тебя нет — только сама форма. Спросят о них — так и скажи.

Текущая форма:
`)
	doc, err := json.MarshalIndent(form, "", " ")
	if err == nil {
		b.Write(doc)
	}
	return b.String()
}
