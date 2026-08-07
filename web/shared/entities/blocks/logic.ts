import { z } from 'zod'
import {
  MAX_ID_LEN,
  MAX_JUMP_RULES,
  MAX_LOGIC_DEPTH,
  MAX_LOGIC_NODES,
  MAX_LOGIC_VALUE_LEN,
} from './limits'

// Контракт условной логики (фаза 21) — ФОРМА правил. Вычислитель живёт отдельно
// (@fields/logic.ts): ему нужен раскладчик страниц, а entities не может зависеть от
// fields. Зеркало Go — internal/domain/logic.go (форма и лимиты) с тем же составом
// проверок; спека — docs/design/logic.md, решения — ADR §10.
//
// Одно дерево на все четыре правила: `visibleIf` у головного блока группы, `requiredIf`
// у отвечаемого блока, `visibleIf` у варианта, `jumpIf` у разрыва страницы. У автора
// одна модель, у нас один вычислитель и один набор тестов.
//
// ЧТО ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ И ПОЧЕМУ: существование блока-источника, его позиция
// относительно носителя, совместимость оператора с типом источника, достижимость цели
// перехода. Всё это кросс-блочное, а кросс-блочные условия в схеме ловили бы 422 в
// автосейве, едва автор перетащил источник ниже зависимого (тот же довод, что у
// инертного бита ряда и инертного разрыва). Неразрешимое правило не отвергается —
// оно ИНЕРТНО, то есть равно отсутствующему (семантика — в вычислителе).

// Операторы сравнения. Порядок контрактный: по этому кортежу идёт паритет-тест с Go
// (internal/domain/logicparity_test.go), который читает ЭТОТ файл.
export const LOGIC_OPERATORS = [
  // наличие ответа — у любого отвечаемого типа
  'answered',
  'empty',
  // равенство: id варианта, число, ConsentYes, точная строка
  'is',
  'is_not',
  // множественный выбор: содержит ли ответ вариант
  'includes',
  'excludes',
  // числовое сравнение — только scale и number
  'gt',
  'lt',
] as const

export type LogicOperator = (typeof LOGIC_OPERATORS)[number]

export const logicOperatorSchema = z.enum(LOGIC_OPERATORS)

// Оператор сравнивает ответ со ЗНАЧЕНИЕМ. У answered/empty значения нет вовсе:
// непустое value у них — мусор в документе, и он отвергается (зеркалит needsValue).
export const opNeedsValue = (op: LogicOperator): boolean => op !== 'answered' && op !== 'empty'

// Ссылка на блок-источник. Своя, а не idSchema из settings.ts: тот файл импортирует
// этот (у варианта есть visibleIf), и обратный импорт замкнул бы цикл. Правило то же —
// непустая строка в пределах длины id.
const blockRefSchema = z.string().min(1).max(MAX_ID_LEN)

// Лист условия: на чей ответ смотрим, как сравниваем и с чем.
//
// value необязательно и МОЖЕТ БЫТЬ ПУСТЫМ — это законное состояние черновика: автор
// добавил условие и ещё не выбрал значение. Правило с пустым значением инертно, а не
// невалидно, иначе попап настроек ловил бы 422 на каждом полуготовом условии.
const leafSchema = z
  .strictObject({
    blockId: blockRefSchema,
    op: logicOperatorSchema,
    value: z.string().max(MAX_LOGIC_VALUE_LEN).optional(),
  })
  .superRefine((leaf, ctx) => {
    if (leaf.value && !opNeedsValue(leaf.op)) {
      ctx.addIssue({
        code: 'custom',
        message: `оператор ${leaf.op} не сравнивает со значением`,
        path: ['value'],
      })
    }
  })

// Узел дерева: группа «все», группа «любое» или лист. Ровно одна форма — объединение
// строгих объектов: смесь ключей (`{all, blockId}`) не проходит ни один вариант, пустой
// объект и пустая группа — тоже. Зеркалит взаимоисключающие ветви в Go.
export type LogicCondition =
  | { all: LogicCondition[] }
  | { any: LogicCondition[] }
  | { blockId: string; op: LogicOperator; value?: string }

export const conditionSchema: z.ZodType<LogicCondition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(conditionSchema).min(1) }),
    z.strictObject({ any: z.array(conditionSchema).min(1) }),
    leafSchema,
  ]),
)

// Размер дерева — свойство ПРАВИЛА целиком, поэтому считается один раз наверху, а не
// в каждом узле: иначе лимит узлов означал бы «сорок на каждую ветку».
const measure = (c: LogicCondition, depth: number): { depth: number; nodes: number } => {
  const children = 'all' in c ? c.all : 'any' in c ? c.any : null
  if (children === null) return { depth, nodes: 1 }
  let maxDepth = depth
  let nodes = 1
  for (const child of children) {
    const m = measure(child, depth + 1)
    maxDepth = Math.max(maxDepth, m.depth)
    nodes += m.nodes
  }
  return { depth: maxDepth, nodes }
}

// Правило — дерево под лимитами. Именно оно ставится в visibleIf/requiredIf/when.
export const ruleSchema = conditionSchema.superRefine((c, ctx) => {
  const { depth, nodes } = measure(c, 1)
  if (depth > MAX_LOGIC_DEPTH) {
    ctx.addIssue({ code: 'custom', message: `вложенность условий глубже ${MAX_LOGIC_DEPTH}` })
  }
  if (nodes > MAX_LOGIC_NODES) {
    ctx.addIssue({ code: 'custom', message: `больше ${MAX_LOGIC_NODES} условий` })
  }
})

// Переход со страницы: условие и цель. Цель — ЛИБО id другого разрыва (страница, которую
// он открывает), ЛИБО end («страниц дальше нет, здесь кнопка Отправить»). Две формы, а
// не зарезервированное значение внутри to: id генерирует клиент, и строка 'end' — сама
// по себе законный id.
export const jumpRuleSchema = z
  .strictObject({
    when: ruleSchema,
    to: z.string().max(MAX_ID_LEN).optional(),
    end: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if (Boolean(r.to) === (r.end === true)) {
      ctx.addIssue({ code: 'custom', message: 'нужна ровно одна цель — to или end' })
    }
  })
export type JumpRule = z.infer<typeof jumpRuleSchema>

export const jumpIfSchema = z.array(jumpRuleSchema).max(MAX_JUMP_RULES)
