package domain

import (
	"fmt"
	"strings"
)

// Гейт публикации (фаза 16, этап 16.5; ADR §10, решение владельца 2026-07-31).
//
// Правило момента ПУБЛИКАЦИИ, а не хранения — и это главная граница файла.
// ValidateSchema намеренно принимает недособранный черновик: пустая подпись и choice
// без вариантов — законное состояние набора, которое автосейв обязан уметь хранить,
// иначе автор ловил бы 422 посреди сборки формы. Но опубликовать такое нельзя:
// респондент увидит пустую строку вместо вопроса или список, из которого нечего
// выбрать. Обещание «непустая подпись, ≥1 опция» стояло комментарием в ValidateSchema
// с фазы 4 и не было реализовано нигде (спека §2.5) — здесь оно наконец выполняется.
//
// Устройство — СПИСОК, а не одноразовая проверка: блокеров сразу три, и автор должен
// увидеть все разом, а не по одному на каждую попытку публикации. Зеркало для
// кабинета — web/app/src/features/forms/builder/publishGate.ts (правится тем же PR,
// тесты обеих сторон): кабинету тот же список нужен ДО нажатия, чтобы не отправлять
// заведомо отказную публикацию. Go при этом остаётся финальной инстанцией — публикация
// мимо кабинета проходит через него же.

// PublishBlockerKind — вид блокера. Строкой, а не числом: значение уходит на провод и
// читается в логах и в кабинете.
type PublishBlockerKind string

const (
	// BlockerUnnamedQuestion — вопрос, которому автор не дал ничего: ни имени, ни
	// заголовка, ни своего текста, ни плейсхолдера. В выгрузке такой станет «Шкала 3».
	BlockerUnnamedQuestion PublishBlockerKind = "unnamed_question"
	// BlockerEmptyCaption — подпись (title/label) с пустым текстом: у респондента это
	// пустая строка на месте вопроса.
	BlockerEmptyCaption PublishBlockerKind = "empty_caption"
	// BlockerChoiceWithoutOptions — список выбора без единого варианта: выбрать нечего.
	BlockerChoiceWithoutOptions PublishBlockerKind = "choice_without_options"
)

// PublishBlocker — одна причина отказа, привязанная к БЛОКУ: кабинет по этому id
// переводит каретку на строку, а не оставляет автора искать её глазами.
type PublishBlocker struct {
	BlockID string             `json:"blockId"`
	Kind    PublishBlockerKind `json:"kind"`
	Message string             `json:"message"`
}

// PublishBlockers — список блокеров, он же ошибка. Заворачивает ErrValidation (→ 422,
// как AnswerErrors), а respond.go достаёт список через errors.As и кладёт в конверт.
// Один блок может дать НЕСКОЛЬКО блокеров (голый список выбора без заголовка — сразу
// два), поэтому список, а не карта по block_id: карта потеряла бы второй.
type PublishBlockers []PublishBlocker

func (b PublishBlockers) Error() string {
	parts := make([]string, 0, len(b))
	for _, x := range b {
		parts = append(parts, fmt.Sprintf("%s: %s", x.BlockID, x.Message))
	}
	return "форму нельзя опубликовать: " + strings.Join(parts, "; ")
}

// Is делает errors.Is(err, ErrValidation) истинным — единый маппинг на 422.
func (b PublishBlockers) Is(target error) bool { return target == ErrValidation }

// PublishGate возвращает блокеры публикации в порядке документа (кабинет показывает
// их списком сверху вниз — тем же порядком, каким автор идёт по полотну). nil значит
// «публиковать можно».
//
// Пустая форма блокеров не даёт: форма без единого вопроса — законный документ
// (страница с одним текстом), и запрещать её публикацию гейт не нанимался.
func PublishGate(s FormSchema) PublishBlockers {
	caps := groupCaptions(s.Blocks)
	var out PublishBlockers
	for _, b := range s.Blocks {
		// Порядок проверок внутри блока значения не имеет: они независимы, и блок,
		// нарушивший два правила, обязан дать два замечания — «почините одно, узнаете
		// про второе» это ровно то, чего список и избегает.
		if b.Type.isAnswerable() && authoredLabel(b, caps[b.GroupID]) == "" {
			out = append(out, PublishBlocker{
				BlockID: b.ID,
				Kind:    BlockerUnnamedQuestion,
				Message: "у вопроса нет имени: впишите заголовок или задайте имя в настройках блока",
			})
		}
		if b.Type.isCaption() && strings.TrimSpace(PlainText(b.Text)) == "" {
			out = append(out, PublishBlocker{
				BlockID: b.ID,
				Kind:    BlockerEmptyCaption,
				Message: "пустая подпись: впишите текст вопроса или удалите строку",
			})
		}
		if b.Type.isChoice() && len(b.Settings.Options) == 0 {
			out = append(out, PublishBlocker{
				BlockID: b.ID,
				Kind:    BlockerChoiceWithoutOptions,
				Message: "в списке нет ни одного варианта: добавьте хотя бы один",
			})
		}
	}
	return out
}
