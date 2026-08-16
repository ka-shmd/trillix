import { z } from 'zod'

import { ruleSchema } from './conditions'
import { type BlockKindContract } from './contract'
import { MAX_ID_LEN, MAX_LOGIC_ACTIONS, MAX_LOGIC_TARGETS } from './limits'

// Блок условной логики — «Когда <условие> → тогда <действия>». Правило перестало быть
// невидимым свойством вопроса и стало строкой полотна, которую видно при чтении формы
// сверху вниз. Спека — docs/design/logic-blocks.md, решения — ADR §10.
//
// Респонденту не показывается (контрола нет, BlockField отсекает выше). Форма условия —
// blocks/conditions.ts, семантика применения — @fields/logic.ts, зеркало Go —
// internal/domain/logic.go.
//
// ГДЕ СТОИТ БЛОК, ДЕЙСТВИЮ НАД ЦЕЛЬЮ БЕЗРАЗЛИЧНО (2026-08-16): инертность меряется у
// ЦЕЛИ — источник обязан быть решён к моменту, когда решается она. Позиция блока значима
// ровно для перехода и «скрыть кнопку»: у них цель — страница, на которой он стоит.
// Нарушение делает лист или действие ИНЕРТНЫМ, а не невалидным: проверка кросс-блочная,
// и валидатор ловил бы 422 в автосейве, едва автор потянул блок мышью. Здесь поэтому
// проверяется только форма.

// Действия — В ПОРЯДКЕ КОНТРАКТА: по этому кортежу идёт паритет с Go
// (internal/domain/logicparity_test.go, он читает ЭТОТ файл).
export const LOGIC_ACTIONS = [
  // видимость цели: 'show' переворачивает умолчание в «скрыт», 'hide' оставляет
  // «виден» и прячет по условию
  'show',
  'hide',
  // обязательность отвечаемого блока; складывается с флагом required по ИЛИ
  'require',
  // переход со страницы, на которой стоит блок
  'jump',
  // «кнопки нет»: обход завершается на этой странице, отправить форму нельзя
  'block_submit',
] as const

export type LogicActionKind = (typeof LOGIC_ACTIONS)[number]

export const logicActionKindSchema = z.enum(LOGIC_ACTIONS)

// Ссылка на блок — своя, а не idSchema из settings.ts: тот файл импортирует conditions.ts,
// и путь импортов держится деревом (см. доклок limits.ts). Правило то же — непустая
// строка в пределах длины id.
const blockRefSchema = z.string().min(1).max(MAX_ID_LEN)

// Цели — СПИСОК id, и в нём вперемешку блоки и ВАРИАНТЫ выбора (решение владельца
// 2026-08-16, образец — Tally: в дереве целей вариант такой же узел, что и вопрос).
// Отдельного действия «скрыть варианты» поэтому нет: одно «скрыть» прячет и вопрос, и
// отдельные его варианты, а кто чем оказался, разбирает вычислитель по документу.
//
// Список, а не одна цель: автор прячет ветку целиком одним движением, и пять действий
// вместо одного сделали бы блок нечитаемым.
//
// Ссылаться можно на id блока или варианта, но НЕ на `groupId`: тот ВЫВОДИТСЯ (regroup) и
// сущностью схемы не является. Блок-цель у показа — голова группы: прячется вопрос
// целиком, и это единственное, что осталось от прежнего носителя `visibleIf`.
const targetActionSchema = z.strictObject({
  kind: z.enum(['show', 'hide', 'require']),
  targets: z.array(blockRefSchema).min(1).max(MAX_LOGIC_TARGETS),
})

// Цель перехода — ЛИБО id разрыва (страница, которую он открывает), ЛИБО end («страниц
// дальше нет, здесь кнопка Отправить»). Две формы, а не зарезервированное значение
// внутри to: id генерирует клиент, и строка 'end' — сама по себе законный id.
const jumpActionSchema = z
  .strictObject({
    kind: z.literal('jump'),
    to: z.string().max(MAX_ID_LEN).optional(),
    end: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    if (Boolean(a.to) === (a.end === true)) {
      ctx.addIssue({ code: 'custom', message: 'нужна ровно одна цель — to или end' })
    }
  })

// Цели нет вовсе: действие про страницу, на которой блок стоит.
const blockSubmitActionSchema = z.strictObject({ kind: z.literal('block_submit') })

export type LogicAction =
  | { kind: 'show' | 'hide' | 'require'; targets: string[] }
  | { kind: 'jump'; to?: string; end?: boolean }
  | { kind: 'block_submit' }

export const logicActionSchema: z.ZodType<LogicAction> = z.union([
  targetActionSchema,
  jumpActionSchema,
  blockSubmitActionSchema,
])

// Содержимое блока. Обе половины НЕОБЯЗАТЕЛЬНЫ по отдельности: блок, у которого автор
// ещё не выбрал условие или ещё не выбрал действие, — законное состояние черновика,
// ровно как лист с пустым value. Полупустой блок инертен целиком, то есть форма ведёт
// себя так, будто его нет.
export const blockLogicSchema = z.strictObject({
  when: ruleSchema.optional(),
  then: z.array(logicActionSchema).max(MAX_LOGIC_ACTIONS).optional(),
})
export type BlockLogic = z.infer<typeof blockLogicSchema>

// Тип блока в реестре (фаза 16, спека §3.2). Контент, а не отдельная семья: ответа не
// собирает, и все правила неотвечаемого блока — вне CSV, вне сводки, вне модели
// вопросов — ровно те, что ему нужны.
export const logic: BlockKindContract = {
  family: 'content',
  // Своего текста не несёт: всё, что в блоке написано, — это выбранные источники, цели
  // и операторы, то есть ссылки, а не текст автора.
  carriesText: false,
  // Ряд делить не может — третий такой тип после заголовка формы и разрыва страницы, и
  // по тому же доводу: правило не элемент раскладки. Половина ряда, в которой стоит
  // условие, не значит ничего.
  canShareRow: false,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
