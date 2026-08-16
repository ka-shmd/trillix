import {
  type Block,
  type BlockType,
  type LogicCondition,
  type LogicOperator,
  LOGIC_OPERATORS,
  isAnswerableType,
  isMultiChoiceType,
  isSingleChoiceType,
  opNeedsValue,
} from '@entities/formSchema'

import { type Answer } from './answer'
import { splitPagesWithClosers } from './groups'

// Вычислитель условной логики — что видит респондент при данных ответах.
// Зеркало internal/domain/logic.go (PlanForm/StripHiddenAnswers): таблица кейсов
// одинакового состава живёт с обеих сторон, паритет операторов и действий сторожит
// Go-тест. Спеки — docs/design/logic.md и logic-blocks.md, решения — ADR §10.
//
// ПРАВИЛО ЖИВЁТ В БЛОКЕ `logic`, и раскладывается по адресатам ДО обхода (compileLogic),
// поэтому сам обход про блоки логики не знает — он читает те же карты, что и раньше.
//
// ГДЕ СТОИТ БЛОК, ДЕЙСТВИЮ НАД ЦЕЛЬЮ БЕЗРАЗЛИЧНО (2026-08-16, ADR §10). Единственное,
// что нужно однопроходному обходу, — чтобы источник был решён к моменту, когда решается
// ЦЕЛЬ; значит и мерить инертность надо у цели, а не у блока. Блок при этом волен стоять
// где угодно, в том числе ниже того, что прячет. Позиция блока остаётся значимой ровно
// для двух действий, у которых цель — не блок, а страница: перехода и «скрыть кнопку».
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
  // Обязательные ФАКТИЧЕСКИ (флаг required или сработавшее действие), только среди
  // видимых.
  required: Set<string>
  // Видимость вариантов — только у блоков, которых касается хоть одно правило.
  // Отсутствие блока в карте читается как «видны все»: иначе каждый список платил бы
  // множеством на ровном месте.
  options: Map<string, Set<string>>
  // Обход упёрся в действие «скрыть кнопку»: на последней показанной странице кнопки
  // нет, и форму отправить нельзя. Не то же самое, что «страниц больше нет».
  blocked: boolean
}

// Одно ПРАВИЛО, откуда бы оно ни пришло — из блока `logic` или из старого поля-носителя.
// Обе стороны сводятся сюда до обхода, поэтому сам обход про блоки логики не знает.
type Rule = {
  when: LogicCondition | undefined
  // Позиция БЛОКА. Нужна там, где цель — страница (переход, «скрыть кнопку»): условие
  // считается от места, где блок стоит. Для действий над блоком-целью не используется:
  // там инертность меряется у самой цели (см. collect).
  at: number
}

type JumpEntry = { owner: string; rule: Rule; to?: string; end?: boolean }

// Правила документа, разложенные по адресатам. Карты — те же, которыми обход пользовался
// и раньше; изменилось только то, откуда они заполняются.
type Compiled = {
  shows: Map<string, Rule[]>
  hides: Map<string, Rule[]>
  requires: Map<string, Rule[]>
  optionShows: Map<string, Map<string, Rule[]>>
  optionHides: Map<string, Map<string, Rule[]>>
  jumps: JumpEntry[]
  submitBlocks: { owner: string; rule: Rule }[]
}

function compileLogic(blocks: readonly Block[]): Compiled {
  // Кто есть кто в документе: цель действия — id блока ЛИБО id варианта, и разобрать это
  // может только документ. Блок старше варианта при совпадении id.
  const isBlock = new Set(blocks.map((b) => b.id))
  const optionOwner = new Map<string, string>()
  for (const b of blocks) {
    for (const o of b.settings?.options ?? []) {
      if (!optionOwner.has(o.id)) optionOwner.set(o.id, b.id)
    }
  }
  const c: Compiled = {
    shows: new Map(),
    hides: new Map(),
    requires: new Map(),
    optionShows: new Map(),
    optionHides: new Map(),
    jumps: [],
    submitBlocks: [],
  }
  const push = (m: Map<string, Rule[]>, key: string, r: Rule): void => {
    const list = m.get(key)
    if (list) list.push(r)
    else m.set(key, [r])
  }
  const pushOptions = (
    m: Map<string, Map<string, Rule[]>>,
    blockId: string,
    optionIds: readonly string[],
    r: Rule,
  ): void => {
    let byOption = m.get(blockId)
    if (!byOption) {
      byOption = new Map()
      m.set(blockId, byOption)
    }
    for (const id of optionIds) {
      const list = byOption.get(id)
      if (list) list.push(r)
      else byOption.set(id, [r])
    }
  }

  blocks.forEach((b, i) => {
    if (b.type !== 'logic') return
    // У блока одно условие на все свои действия. Позиция нужна только там, где цель —
    // страница (переход, «скрыть кнопку»).
    const rule: Rule = { when: b.logic?.when, at: i }
    for (const a of b.logic?.then ?? []) {
      switch (a.kind) {
        case 'show':
        case 'hide': {
          const m = a.kind === 'show' ? c.shows : c.hides
          const om = a.kind === 'show' ? c.optionShows : c.optionHides
          for (const id of a.targets) {
            if (isBlock.has(id)) {
              push(m, id, rule)
              continue
            }
            const owner = optionOwner.get(id)
            if (owner !== undefined) pushOptions(om, owner, [id], rule)
            // Ни блок, ни вариант — ссылка в никуда, действие инертно.
          }
          break
        }
        case 'require':
          // Вариант обязательным не бывает: ссылка на него инертна.
          for (const id of a.targets) {
            if (isBlock.has(id)) push(c.requires, id, rule)
          }
          break
        case 'jump':
          c.jumps.push({ owner: b.id, rule, to: a.to, end: a.end })
          break
        case 'block_submit':
          c.submitBlocks.push({ owner: b.id, rule })
          break
      }
    }
  })
  return c
}

// Показан ли вариант. Отдельная функция, потому что «карты нет» и «вариант скрыт» —
// разные вещи, и путать их нельзя. Зеркалит Plan.OptionVisible в Go.
export function optionVisible(plan: FormPlan, blockId: string, optionId: string): boolean {
  const opts = plan.options.get(blockId)
  return opts === undefined || opts.has(optionId)
}

// Блок, каким его видит респондент: со скрытыми вариантами, вычищенными из списка.
// Возвращает ИСХОДНЫЙ объект, когда прятать нечего, — новый объект на каждый рендер
// заставлял бы React считать поле изменившимся там, где ничего не изменилось.
//
// Фильтруем сам блок, а не прокидываем множество видимых через контракт контролов:
// иначе о видимости пришлось бы знать каждому типу поля (список, выпадающий список и
// всякий будущий), а знать об этом не должен ни один — «варианты блока» это то, что в
// блоке лежит. Бесплатно чинится и буквенный бейдж: буквы считаются по позиции в
// списке, и у отфильтрованного списка они идут подряд, без дырок на месте скрытых.
export function withVisibleOptions(block: Block, plan: FormPlan): Block {
  const opts = plan.options.get(block.id)
  if (opts === undefined) return block
  const options = block.settings?.options ?? []
  const kept = options.filter((o) => opts.has(o.id))
  if (kept.length === options.length) return block
  return { ...block, settings: { ...block.settings, options: kept } }
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
  const plan: FormPlan = {
    pages: [],
    visible: new Set(),
    required: new Set(),
    options: new Map(),
    blocked: false,
  }
  const compiled = compileLogic(blocks)

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

  // Сработало ли ОДНО правило. Инертное (нет условия, источник ниже носителя, оператор
  // не подходит типу, значение не выбрано) не срабатывает никогда.
  const fires = (r: Rule): boolean => {
    if (r.when === undefined) return false
    const [res, ok] = evalNode(r.when, r.at)
    return ok && res
  }

  // Правила, адресованные ЦЕЛИ на позиции target: сколько из них действуют и сработало
  // ли хоть одно. Условие считается ОТ ЦЕЛИ, а не от блока: источник обязан быть решён
  // к моменту, когда решается цель, и это единственное, чего требует однопроходный
  // обход. Где при этом стоит сам блок — не важно.
  const collect = (rules: Rule[] | undefined, target: number): [boolean, boolean] => {
    let active = false
    let fired = false
    for (const r of rules ?? []) {
      if (r.when === undefined) continue
      const [res, ok] = evalNode(r.when, target)
      if (!ok) continue
      active = true
      if (res) fired = true
    }
    return [active, fired]
  }

  // Видна ли цель. Две корзины, и формула не зависит от порядка блоков `logic` между
  // собой: «показать» переворачивает умолчание цели в «скрыт», «скрыть» прячет видимое
  // по условию (ADR §10). Ни одного действующего правила — виден, как и было.
  const shows = (id: string, target: number): boolean => {
    const [hasShow, showFired] = collect(compiled.shows.get(id), target)
    const [, hideFired] = collect(compiled.hides.get(id), target)
    return (!hasShow || showFired) && !hideFired
  }

  let next = 0
  pages.forEach((page, i) => {
    const visited = i === next
    const shown: Block[] = []

    for (const [start, end] of groupRuns(page.blocks)) {
      const head = page.blocks[start]!
      const show = visited && shows(head.id, pos.get(head.id) ?? 0)

      for (const b of page.blocks.slice(start, end)) {
        // Блок логики не показывается никому и ни на одной поверхности: страница, где
        // кроме него ничего нет, — не страница (её переходы при этом считаются).
        if (show && b.type !== 'logic') {
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
        const at = pos.get(b.id) ?? 0
        const opts = visibleOptions(b, compiled, collect, at)
        if (opts !== null) plan.options.set(b.id, opts)
        decided.set(b.id, decodeAnswer(b, answers[b.id], opts))
        if (b.required === true || collect(compiled.requires.get(b.id), at)[1]) {
          plan.required.add(b.id)
        }
      }
    }

    if (!visited) return
    // Страница, где не осталось ни одного видимого блока, посещается (её переходы
    // считаются), но респонденту не показывается: пустой шаг с одной кнопкой «Далее» —
    // это не страница.
    if (shown.length > 0) plan.pages.push(shown)

    const here = new Set(page.blocks.map((b) => b.id))
    if (page.closer) here.add(page.closer.id)
    // «Скрыть кнопку» обрывает обход ЗДЕСЬ: страница показана, кнопки нет, идти
    // некуда. Проверяется до переходов — уйти со страницы, которую нельзя закрыть,
    // нельзя.
    if (compiled.submitBlocks.some((s) => here.has(s.owner) && fires(s.rule))) {
      plan.blocked = true
      return
    }
    next = i + 1
    for (const j of compiled.jumps) {
      if (!here.has(j.owner) || !fires(j.rule)) continue
      if (j.end === true) {
        next = pages.length // страниц дальше нет: здесь кнопка «Отправить»
        break
      }
      const target = j.to === undefined ? undefined : opens.get(j.to)
      // Переход назад и в никуда инертен: обход монотонен по построению, и цикла
      // «страница 2 → страница 1 → страница 2» не существует.
      if (target === undefined || target <= i) continue
      next = target
      break
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

// Операторы, осмысленные у этого типа источника, — В ПОРЯДКЕ КОНТРАКТА. Один источник
// на две стороны: вычислитель спрашивает «подходит ли» (opApplies ниже), редактор
// показывает автору ровно этот список. Разъедься они — билдер предлагал бы выбор,
// который движок считает инертным, то есть молча не работающим.
export function operatorsFor(type: BlockType): LogicOperator[] {
  if (!isAnswerableType(type)) return []
  const numeric = type === 'scale' || type === 'number'
  const multi = isMultiChoiceType(type)
  return LOGIC_OPERATORS.filter((op) => {
    switch (op) {
      case 'answered':
      case 'empty':
        return true
      case 'is':
      case 'is_not':
        return !multi
      case 'includes':
      case 'excludes':
        return multi
      case 'gt':
      case 'lt':
        return numeric
    }
  })
}

// Осмыслен ли оператор у типа источника. Схемой НЕ проверяется (смена типа источника
// иначе роняла бы 422 в автосейв) — несовместимая пара делает правило инертным.
function opApplies(op: LogicOperator, src: Block): boolean {
  return operatorsFor(src.type).includes(op)
}

// Почему правило не действует — для ПРЕДУПРЕЖДЕНИЙ билдера (не для схемы: там всё это
// законно, см. доклок). Пусто — правило действует.
//
// Живёт рядом с вычислителем, а не в редакторе, ровно по одной причине: причин
// инертности четыре, и вторая их копия в билдере разъехалась бы с первой на первой же
// правке — автор получил бы зелёное правило, которое молча ничего не делает.
export type RuleWarning = { blockId: string; reason: string }

export function ruleWarnings(
  blocks: readonly Block[],
  carrierId: string,
  cond: LogicCondition | undefined,
): RuleWarning[] {
  if (cond === undefined) return []
  const carrier = blocks.findIndex((b) => b.id === carrierId)
  const out: RuleWarning[] = []

  const walk = (c: LogicCondition): void => {
    if ('all' in c) {
      c.all.forEach(walk)
      return
    }
    if ('any' in c) {
      c.any.forEach(walk)
      return
    }
    const at = blocks.findIndex((b) => b.id === c.blockId)
    if (at < 0) {
      out.push({ blockId: c.blockId, reason: 'вопрос-источник удалён' })
      return
    }
    if (carrier >= 0 && at >= carrier) {
      out.push({ blockId: c.blockId, reason: 'источник стоит ниже — условие не действует' })
      return
    }
    if (!opApplies(c.op, blocks[at]!)) {
      out.push({ blockId: c.blockId, reason: 'сравнение не подходит типу источника' })
      return
    }
    if (opNeedsValue(c.op) && (c.value ?? '') === '') {
      out.push({ blockId: c.blockId, reason: 'не выбрано значение' })
    }
  }

  walk(cond)
  return out
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

// Видимость вариантов; null, если блока не касается ни одно правило (значит видны все).
// Формула у варианта та же, что у блока (§3.2 спеки): две корзины, порядок не влияет.
function visibleOptions(
  b: Block,
  compiled: Compiled,
  collect: (rules: Rule[] | undefined, target: number) => [boolean, boolean],
  at: number,
): Set<string> | null {
  const options = b.settings?.options
  if (!options) return null
  const shows = compiled.optionShows.get(b.id)
  const hides = compiled.optionHides.get(b.id)
  if (!shows && !hides) return null
  const out = new Set<string>()
  for (const o of options) {
    const [hasShow, showFired] = collect(shows?.get(o.id), at)
    const [, hideFired] = collect(hides?.get(o.id), at)
    if ((!hasShow || showFired) && !hideFired) out.add(o.id)
  }
  return out
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
export function stripHiddenAnswers(
  blocks: readonly Block[],
  answers: Answers,
): Record<string, Answer> {
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
