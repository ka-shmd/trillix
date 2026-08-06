import {
  type Block,
  type LogicCondition,
  type LogicOperator,
  isAnswerableType,
  isMultiChoiceType,
  isSingleChoiceType,
  opNeedsValue,
} from '@entities/formSchema'

import { type Answer } from './answer'
import { splitPagesWithClosers } from './groups'

// Вычислитель условной логики (фаза 21) — что видит респондент при данных ответах.
// Зеркало internal/domain/logic.go (PlanForm/StripHiddenAnswers): таблица кейсов
// одинакового состава живёт с обеих сторон, паритет операторов сторожит Go-тест.
// Спека — docs/design/logic.md, решения — ADR §10.
//
// Один исходник на три поверхности фронта: рендерер, превью билдера и — там, где
// понадобится — полотно. Разъедься они, и автор увидел бы в превью не ту форму, что
// респондент, а логику иначе как превью не проверить.
//
// ЖИВЁТ В @fields, а не в @entities, ровно по одной причине: ему нужен раскладчик
// страниц (splitPagesWithClosers), а entities не может зависеть от fields — импорты
// направлены вниз. Форма правил при этом осталась в контракте (blocks/logic.ts).
//
// ГЛАВНОЕ ПРАВИЛО СЕМАНТИКИ: инертное правило равно отсутствующему. Условие, которое
// невозможно разрешить (источника нет, источник ниже носителя, оператор не подходит его
// типу, значение не выбрано), не отвергается и не считается ложным — оно не действует:
// вопрос показывается, обязательность не возникает, переход не срабатывает. Скрытый
// источник — другое дело: его ответ считается ПУСТЫМ, и условие считается по пустому.

export type Answers = Readonly<Record<string, Answer | undefined>>

export type FormPlan = {
  // Посещаемые страницы в порядке прохода, в них только видимые блоки. Страниц всегда
  // хотя бы одна (как у splitPages): пустой документ — это один пустой шаг с кнопкой.
  pages: Block[][]
  visible: Set<string>
  // Обязательные ФАКТИЧЕСКИ (required или сработавший requiredIf), только среди видимых.
  required: Set<string>
  // Видимость вариантов — только у блоков, где правило есть хотя бы у одного варианта.
  // Отсутствие блока в карте читается как «видны все»: иначе каждый список платил бы
  // множеством на ровном месте.
  options: Map<string, Set<string>>
}

// Показан ли вариант. Отдельная функция, потому что «карты нет» и «вариант скрыт» —
// разные вещи, и путать их нельзя. Зеркалит Plan.OptionVisible в Go.
export function optionVisible(plan: FormPlan, blockId: string, optionId: string): boolean {
  const opts = plan.options.get(blockId)
  return opts === undefined || opts.has(optionId)
}

// Ответ в виде, пригодном для сравнения: строка у всех типов, кроме множественного
// выбора. Скрытые варианты уже вычищены.
type Decided = { text: string; list: string[] }

const EMPTY: Decided = { text: '', list: [] }

const isEmpty = (v: Decided): boolean => v.text === '' && v.list.length === 0

export function planForm(blocks: readonly Block[], answers: Answers): FormPlan {
  const pages = splitPagesWithClosers([...blocks])
  const pos = new Map<string, number>()
  const byId = new Map<string, Block>()
  blocks.forEach((b, i) => {
    pos.set(b.id, i)
    byId.set(b.id, b)
  })

  // Куда ведёт каждый разрыв: страница СРАЗУ ЗА той, которую он закрывает. Разрыв, за
  // которым страницы нет, цели не имеет — переход на него не действует.
  const opens = new Map<string, number>()
  pages.forEach((p, i) => {
    if (p.closer && i + 1 < pages.length) opens.set(p.closer.id, i + 1)
  })

  const decided = new Map<string, Decided>()
  const plan: FormPlan = { pages: [], visible: new Set(), required: new Set(), options: new Map() }

  // Условие. Второе значение — «правило действует»: false = инертно, и каждый
  // потребитель трактует инертность по-своему («как если бы правила не было»).
  const evalNode = (c: LogicCondition, carrier: number): [boolean, boolean] => {
    if (!('all' in c) && !('any' in c)) return evalLeaf(c, carrier)

    const and = 'all' in c
    const children = 'all' in c ? c.all : c.any
    // Дети считаются ВСЕ, без раннего выхода: инертный ребёнок делает инертным правило
    // целиком, а с ранним выходом результат зависел бы от порядка условий в группе.
    let out = and
    for (const child of children) {
      const [res, ok] = evalNode(child, carrier)
      if (!ok) return [false, false]
      out = and ? out && res : out || res
    }
    return [out, true]
  }

  const evalLeaf = (
    c: { blockId: string; op: LogicOperator; value?: string },
    carrier: number,
  ): [boolean, boolean] => {
    const src = byId.get(c.blockId)
    if (src === undefined) return [false, false] // источника нет в документе
    if ((pos.get(c.blockId) ?? 0) >= carrier) return [false, false] // не решён к этому месту
    if (!opApplies(c.op, src)) return [false, false] // оператор не подходит типу
    const value = c.value ?? ''
    if (opNeedsValue(c.op) && value === '') return [false, false] // значение не выбрано

    const val = decided.get(c.blockId) ?? EMPTY
    switch (c.op) {
      case 'answered':
        return [!isEmpty(val), true]
      case 'empty':
        return [isEmpty(val), true]
      case 'is':
        return [sameAnswer(src, val.text, value), true]
      case 'is_not':
        // Строгое отрицание: у неотвеченного источника «не равно» истинно. Так оператор
        // остаётся композируемым — пара «отвечено И не равно» складывается группой.
        return [!sameAnswer(src, val.text, value), true]
      case 'includes':
        return [val.list.includes(value), true]
      case 'excludes':
        return [!val.list.includes(value), true]
      case 'gt':
      case 'lt': {
        const a = Number(val.text)
        const b = Number(value)
        if (val.text === '' || !Number.isFinite(a) || !Number.isFinite(b)) return [false, true]
        return [c.op === 'gt' ? a > b : a < b, true]
      }
    }
  }

  const rule = (c: LogicCondition | undefined, carrier: number): [boolean, boolean] =>
    c === undefined ? [true, true] : evalNode(c, carrier)

  // Инертное правило видимости = отсутствующее, значит «показать».
  const shows = (c: LogicCondition | undefined, carrier: number): boolean => {
    const [res, ok] = rule(c, carrier)
    return !ok || res
  }

  let next = 0
  pages.forEach((page, i) => {
    const visited = i === next
    const shown: Block[] = []

    for (const [start, end] of groupRuns(page.blocks)) {
      const head = page.blocks[start]!
      const show = visited && shows(head.visibleIf, pos.get(head.id) ?? 0)

      for (const b of page.blocks.slice(start, end)) {
        if (show) {
          plan.visible.add(b.id)
          shown.push(b)
        }
        if (!isAnswerableType(b.type)) continue
        // Ответ фиксируется ВСЕГДА — у скрытого пустым: условия следующих вопросов
        // смотрят сюда, и «пусто» у скрытого это ровно то, чего ждёт автор.
        if (!show) {
          decided.set(b.id, EMPTY)
          continue
        }
        const opts = visibleOptions(b, shows, pos.get(b.id) ?? 0)
        if (opts !== null) plan.options.set(b.id, opts)
        decided.set(b.id, decodeAnswer(b, answers[b.id], opts))
        if (requires(b, rule, pos.get(b.id) ?? 0)) plan.required.add(b.id)
      }
    }

    if (!visited) return
    // Страница, где не осталось ни одного видимого блока, посещается (её переходы
    // считаются), но респонденту не показывается: пустой шаг с одной кнопкой «Далее» —
    // это не страница.
    if (shown.length > 0) plan.pages.push(shown)
    next = i + 1
    if (page.closer) {
      next = nextPage(page.closer, i, pages.length, opens, rule, pos.get(page.closer.id) ?? 0)
    }
  })

  if (plan.pages.length === 0) plan.pages.push([])
  return plan
}

// Участки блоков одной группы внутри страницы. Группа смежна по инварианту схемы,
// поэтому достаточно сравнения с предыдущим groupId.
function groupRuns(blocks: readonly Block[]): [number, number][] {
  const runs: [number, number][] = []
  blocks.forEach((b, i) => {
    const prev = runs[runs.length - 1]
    if (prev && b.groupId === blocks[i - 1]!.groupId) prev[1] = i + 1
    else runs.push([i, i + 1])
  })
  return runs
}

// Осмыслен ли оператор у типа источника. Схемой НЕ проверяется (смена типа источника
// иначе роняла бы 422 в автосейв) — несовместимая пара делает правило инертным.
function opApplies(op: LogicOperator, src: Block): boolean {
  if (!isAnswerableType(src.type)) return false
  switch (op) {
    case 'answered':
    case 'empty':
      return true
    case 'is':
    case 'is_not':
      return !isMultiChoiceType(src.type)
    case 'includes':
    case 'excludes':
      return isMultiChoiceType(src.type)
    case 'gt':
    case 'lt':
      return src.type === 'scale' || src.type === 'number'
  }
}

// Равенство ответа значению. У шкалы и number сравнение ЧИСЛОВОЕ: «5» и «5.0» — один
// ответ, а строковое сравнение зависело бы от того, как респондент напечатал число.
function sameAnswer(src: Block, answer: string, want: string): boolean {
  if (src.type === 'scale' || src.type === 'number') {
    const a = Number(answer)
    const b = Number(want)
    if (answer !== '' && want !== '' && Number.isFinite(a) && Number.isFinite(b)) return a === b
  }
  return answer === want
}

function requires(
  b: Block,
  rule: (c: LogicCondition | undefined, carrier: number) => [boolean, boolean],
  carrier: number,
): boolean {
  if (!b.requiredIf) return b.required === true
  const [res, ok] = rule(b.requiredIf, carrier)
  return ok && res
}

// Видимость вариантов; null, если правил нет ни у одного (значит видны все).
function visibleOptions(
  b: Block,
  shows: (c: LogicCondition | undefined, carrier: number) => boolean,
  carrier: number,
): Set<string> | null {
  const options = b.settings?.options
  if (!options?.some((o) => o.visibleIf)) return null
  const out = new Set<string>()
  for (const o of options) {
    if (shows(o.visibleIf, carrier)) out.add(o.id)
  }
  return out
}

// Куда уходим со страницы i: первое сработавшее правило разрыва. Переход назад, в никуда
// и с несработавшим условием пропускается — он инертен.
function nextPage(
  closer: Block,
  i: number,
  total: number,
  opens: Map<string, number>,
  rule: (c: LogicCondition | undefined, carrier: number) => [boolean, boolean],
  carrier: number,
): number {
  for (const r of closer.jumpIf ?? []) {
    const [res, ok] = rule(r.when, carrier)
    if (!ok || !res) continue
    if (r.end === true) return total // страниц дальше нет: здесь кнопка «Отправить»
    const target = r.to === undefined ? undefined : opens.get(r.to)
    if (target === undefined || target <= i) continue
    return target
  }
  return i + 1
}

// Разбор ответа со вычисткой скрытых вариантов: выбранный скрытый вариант — это НЕ
// выбор, иначе условие «выбрал X» срабатывало бы от значения, которого не показывали.
function decodeAnswer(b: Block, raw: Answer | undefined, opts: Set<string> | null): Decided {
  if (raw === undefined) return EMPTY
  if (isMultiChoiceType(b.type)) {
    if (!Array.isArray(raw)) return EMPTY
    return { text: '', list: opts === null ? [...raw] : raw.filter((id) => opts.has(id)) }
  }
  if (typeof raw !== 'string') return EMPTY
  if (isSingleChoiceType(b.type) && raw !== '' && opts !== null && !opts.has(raw)) return EMPTY
  return { text: raw, list: [] }
}

// Ответы без того, чего респондент не видел: скрытые вопросы и скрытые варианты.
// Возвращает НОВУЮ карту. Зеркалит StripHiddenAnswers в Go — но финальная инстанция там:
// клиент чистит ответ перед отправкой, сервер повторяет это, не доверяя клиенту.
//
// Ответы на блоки, которых нет в схеме, остаются нетронутыми: это нарушение контракта, и
// ловить его обязана валидация, а не нормализация.
export function stripHiddenAnswers(blocks: readonly Block[], answers: Answers): Answers {
  const plan = planForm(blocks, answers)
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const out: Record<string, Answer> = {}

  for (const [id, value] of Object.entries(answers)) {
    if (value === undefined) continue
    const b = byId.get(id)
    if (!b || !isAnswerableType(b.type)) {
      out[id] = value
      continue
    }
    if (!plan.visible.has(id)) continue
    const opts = plan.options.get(id)
    if (opts === undefined) {
      out[id] = value
      continue
    }
    if (Array.isArray(value)) {
      out[id] = value.filter((optionId) => opts.has(optionId))
      continue
    }
    if (value !== '' && !opts.has(value)) continue // скрытый вариант уносит весь ответ
    out[id] = value
  }
  return out
}
