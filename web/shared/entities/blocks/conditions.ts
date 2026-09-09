import { z } from 'zod'
import { MAX_ID_LEN, MAX_LOGIC_DEPTH, MAX_LOGIC_NODES, MAX_LOGIC_VALUE_LEN } from './limits'

// Контракт условной логики — ФОРМА условий (дерево «все/любое/сравнение») и операторы.
// Что с этим деревом делают — в blocks/logic.ts, тип блока `logic`; вычислитель живёт
// отдельно (@fields/logic.ts): ему нужен раскладчик страниц, а entities не может
// зависеть от fields. Зеркало Go — internal/domain/logic.go (форма и лимиты) с тем же
// составом проверок; спеки — docs/design/logic.md (фаза 21) и logic-blocks.md (переезд
// на полотно), решения — ADR §10.
//
// ФАЙЛ НАЗЫВАЕТСЯ conditions.ts, а не logic.ts, с 2026-08-16: имя `<тип>.ts` в этом
// каталоге занято реестром типов блоков (спека фазы 16 §3.2), и `logic.ts` теперь
// принадлежит типу блока `logic`. Дерево условий типом блока не является — оно
// значение, которое блок несёт.
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
  // подстрока — только у текстовых типов (короткий и длинный текст, почта, телефон)
  'contains',
  'not_contains',
  // множественный выбор: содержит ли ответ вариант
  'includes',
  'excludes',
  // порядок — у чисел, шкалы и ДАТЫ (ISO-строка сравнивается лексикографически, а это
  // и есть хронологический порядок)
  'gt',
  'lt',
  'gte',
  'lte',
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
// СРАВНИВАТЬ МОЖНО С ДВУМЯ ВЕЩАМИ, и это ровно один из двух ключей: `value` — заданное
// автором значение (id варианта, число, дата, строка), `valueRef` — id ДРУГОГО
// отвечаемого блока, то есть «сравни с его ответом» («бюджет больше, чем стоимость»).
// Оба сразу — противоречие, а не черновик: непонятно, что из них сравнивать, и такой
// документ отвергается.
//
// Совместимость типов источника и ссылки здесь НЕ проверяется (текст со шкалой сравнить
// нельзя) — это кросс-блочное, как и всё остальное в доклоке файла: несовместимая пара
// делает правило ИНЕРТНЫМ, а не невалидным. Правило домена — у вычислителя
// (@fields/logic.ts, `canReferenceAnswer`).
//
// Оба ключа необязательны и МОГУТ БЫТЬ ПУСТЫМИ — это законное состояние черновика: автор
// добавил условие и ещё не выбрал значение. Правило с пустым значением инертно, а не
// невалидно, иначе попап настроек ловил бы 422 на каждом полуготовом условии.
const leafSchema = z
  .strictObject({
    blockId: blockRefSchema,
    op: logicOperatorSchema,
    value: z.string().max(MAX_LOGIC_VALUE_LEN).optional(),
    // Пустая строка здесь равна отсутствующему ключу — как и у `value`, и по
    // техническому доводу: в Go пустое поле и пропущенное неразличимы (пустая структура
    // и omitempty), а расхождение сторон в том, что считать валидным документом, — это
    // 422 на ровном месте. Строгость `min(1)` осталась у blockId: там пусто значит
    // «лист без источника», то есть сломанная форма узла, и Go отвергает её тоже.
    valueRef: z.string().max(MAX_ID_LEN).optional(),
  })
  .superRefine((leaf, ctx) => {
    if (leaf.value && leaf.valueRef) {
      ctx.addIssue({
        code: 'custom',
        message: 'у условия и значение, и ссылка на ответ',
        path: ['valueRef'],
      })
    }
    if (!opNeedsValue(leaf.op)) {
      if (leaf.value) {
        ctx.addIssue({
          code: 'custom',
          message: `оператор ${leaf.op} не сравнивает со значением`,
          path: ['value'],
        })
      }
      if (leaf.valueRef) {
        ctx.addIssue({
          code: 'custom',
          message: `оператор ${leaf.op} не сравнивает со значением`,
          path: ['valueRef'],
        })
      }
    }
  })

// Узел дерева: группа «все», группа «любое» или лист. Ровно одна форма — объединение
// строгих объектов: смесь ключей (`{all, blockId}`) не проходит ни один вариант, пустой
// объект и пустая группа — тоже. Зеркалит взаимоисключающие ветви в Go.
export type LogicCondition =
  | { all: LogicCondition[] }
  | { any: LogicCondition[] }
  | { blockId: string; op: LogicOperator; value?: string; valueRef?: string }

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

// Правило — дерево под лимитами. Именно оно ставится в `logic.when` блока условия.
export const ruleSchema = conditionSchema.superRefine((c, ctx) => {
  const { depth, nodes } = measure(c, 1)
  if (depth > MAX_LOGIC_DEPTH) {
    ctx.addIssue({ code: 'custom', message: `вложенность условий глубже ${MAX_LOGIC_DEPTH}` })
  }
  if (nodes > MAX_LOGIC_NODES) {
    ctx.addIssue({ code: 'custom', message: `больше ${MAX_LOGIC_NODES} условий` })
  }
})

