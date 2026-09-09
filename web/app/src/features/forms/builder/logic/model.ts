import {
  type Block,
  type BlockType,
  type LogicActionKind,
  type LogicCondition,
  type LogicOperator,
  isAnswerableType,
  isChoiceType,
  plainText,
  scaleRange,
} from '@entities/formSchema'
import { pageName, pageNumbers, thankYouOpener } from '@fields/groups'
import { canReferenceAnswer, operatorsFor, ruleWarnings } from '@fields/logic'

import { editorKind } from '../kinds'
import { derivedQuestionName } from '../questionName'

// Правила РЕДАКТОРА условной логики: из чего автор выбирает источник, что можно взять
// целью действия, как правило читается одной строкой. Семантику (что правило значит и
// когда оно инертно) знает вычислитель @fields/logic — здесь её нет и не должно быть:
// вторая копия разъехалась бы с первой.

// Отвечаемые вопросы ВЫШЕ носителя. Носитель здесь настоящий — строка, в которую
// подставляют ответ (`@`, RichLine): там ссылка вперёд действительно бессмысленна.
export function sourcesFor(blocks: readonly Block[], carrierId: string): Block[] {
  const at = blocks.findIndex((b) => b.id === carrierId)
  if (at < 0) return []
  return blocks.slice(0, at).filter((b) => isAnswerableType(b.type))
}

// Из чего выбирает источник БЛОК УСЛОВИЯ: любой отвечаемый вопрос формы.
//
// Позиционного фильтра здесь нет с 2026-08-16 (ADR §10). Он был бы неверен: инертность
// меряется у ЦЕЛИ, а не у блока, и «выше блока» ничего не гарантирует — блок волен
// стоять хоть последней строкой. Единственное настоящее условие — «источник выше цели»,
// но целей у правила бывает несколько и в разных местах, поэтому список не сужается, а
// негодную пару называет предупреждение (logicBlockWarnings).
export function logicSources(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => isAnswerableType(b.type))
}

// Как вопрос зовётся в интерфейсе логики — тем же именем, что в данных (колонка CSV,
// шаг воронки). Одно имя на все поверхности: автор не должен догадываться, что
// «Телефон» в выгрузке и «Телефон» в условии — один вопрос.
export function sourceLabel(blocks: readonly Block[], block: Block): string {
  // Копия среза, а не readonly-сигнатура у derivedQuestionName: тот отдаёт список
  // дальше в groupMeta и правку сигнатур тянет через полполотна. Список вопросов
  // короткий, и копия здесь дешевле сквозной правки ради одного вызова.
  return derivedQuestionName([...blocks], block)
}

// Новое условие про этот источник: оператор — первый осмысленный для его типа
// (`answered` у всех, кроме… — список даёт @fields/logic), значение пустое.
//
// Пустое значение ЗАКОННО и делает правило инертным до выбора: автор добавил условие и
// ещё не дошёл до значения — 422 на этом месте был бы наказанием за незаконченную мысль.
export function defaultLeaf(source: Block): LogicCondition {
  const ops = operatorsFor(source.type)
  const op: LogicOperator = ops.includes('is') ? 'is' : (ops[0] ?? 'answered')
  return { blockId: source.id, op }
}

// Значения, из которых выбирают в правой части условия. Пусто — свободный ввод
// (текст, дата, число): закрытого списка у таких типов нет.
export function valueChoices(source: Block): { value: string; label: string }[] {
  if (isChoiceType(source.type)) {
    return (source.settings?.options ?? []).map((o) => ({
      value: o.id,
      label: o.label.trim() || 'Без названия',
    }))
  }
  if (source.type === 'scale') {
    const { min, max } = scaleRange(source)
    return Array.from({ length: max - min + 1 }, (_, i) => ({
      value: String(min + i),
      label: String(min + i),
    }))
  }
  if (source.type === 'consent') {
    return [{ value: 'yes', label: 'Отмечено' }]
  }
  return []
}

// Каким полем вводится значение: у даты — календарь браузера (тот же нативный контрол,
// что у респондента), у числа — числовое поле. Иначе автор набирает дату руками и
// промахивается форматом молча: ответ хранится как YYYY-MM-DD, а пишут «01.05.2026».
export function valueInputType(source: Block): 'date' | 'number' | 'text' {
  if (source.type === 'date') return 'date'
  if (source.type === 'number') return 'number'
  return 'text'
}

// Вопросы, чей ОТВЕТ годится в правую часть условия об этом источнике: правило доменов
// спрашивается у вычислителя (canReferenceAnswer), чтобы список и семантика не
// разъехались. Сам источник из списка убран — «равен сам себе» не условие.
//
// Позиционного фильтра здесь нет по тому же доводу, что у logicSources: инертность
// меряется у ЦЕЛИ, а целей у правила бывает несколько и в разных местах. Ссылку ниже
// цели называет предупреждение (logicBlockWarnings), а не отсутствие пункта.
export function referenceSources(blocks: readonly Block[], source: Block): Block[] {
  return blocks.filter(
    (b) =>
      b.id !== source.id && isAnswerableType(b.type) && canReferenceAnswer(source.type, b.type),
  )
}

// Группа условий — узел с детьми. Корень правила редактор всегда держит группой (два
// способа выразить одно правило означали бы две ветки в каждой его операции), поэтому
// одинокий лист из чужого документа заворачивается на чтении, а не мигрируется в схеме.
export type Group = { all: LogicCondition[] } | { any: LogicCondition[] }

export function asRootGroup(cond: LogicCondition): Group {
  return 'all' in cond || 'any' in cond ? cond : { all: [cond] }
}

// Как оператор зовётся у автора. «Содержит» стоит дважды и это не ошибка: у текста это
// подстрока (contains), у множественного выбора — вариант в ответе (includes), и
// одному типу источника предлагается ровно один из них.
const OPERATOR_LABELS: Record<LogicOperator, string> = {
  answered: 'отвечен',
  empty: 'не отвечен',
  is: 'равен',
  is_not: 'не равен',
  contains: 'содержит',
  not_contains: 'не содержит',
  includes: 'содержит',
  excludes: 'не содержит',
  gt: 'больше',
  lt: 'меньше',
  gte: 'больше или равно',
  lte: 'меньше или равно',
}

// У ДАТЫ порядок называется временем, а не величиной: «дата больше 1 мая» читается как
// ошибка перевода. Оператор при этом тот же самый — разными словами зовётся одно и то
// же сравнение.
const DATE_ORDER_LABELS: Record<'gt' | 'lt' | 'gte' | 'lte', string> = {
  gt: 'позже',
  lt: 'раньше',
  gte: 'не раньше',
  lte: 'не позже',
}

export function operatorLabel(op: LogicOperator, sourceType?: BlockType): string {
  if (sourceType === 'date' && op in DATE_ORDER_LABELS) {
    return DATE_ORDER_LABELS[op as keyof typeof DATE_ORDER_LABELS]
  }
  return OPERATOR_LABELS[op]
}

// Значение поля `to`, означающее «страниц дальше нет». В схеме это отдельный флаг `end`,
// а не строка: id блока генерирует клиент, и 'end' — сам по себе законный id. В UI
// удобнее одно поле выбора, поэтому здесь строка-маркер, а на запись она разворачивается
// в правильную форму (см. JumpTarget в LogicBlockEditor).
export const JUMP_END = '\u0000end'

// ЦЕЛИ ДЕЙСТВИЙ БЛОКА `logic` — ЛЮБОЙ подходящий блок формы, а не только стоящий ниже
// (решение владельца 2026-08-16, образец — Tally). Сужает список только вид действия:
// прятать можно вопрос, обязательным делать — отвечаемый, варианты бывают у списка.
//
// Позиция блока цели не касается: обходу важно, чтобы источник был решён к моменту,
// когда решается ЦЕЛЬ, а где при этом стоит блок — не важно. Негодную пару «источник
// ниже цели» называет предупреждение, а не отсутствие пункта в списке.

// Как называется цель в списке. У отвечаемого — то же имя, что в данных; у подписи и
// контента имени в данных нет, поэтому берётся их собственный текст.
export function targetLabel(blocks: readonly Block[], block: Block): string {
  if (isAnswerableType(block.type)) return sourceLabel(blocks, block)
  return captionOf(block) || derivedQuestionName([...blocks], block)
}

// Страница, на которой стоит блок, — по ТОМУ ЖЕ разбиению, которым форма режется
// респонденту (pageNumbers). Собственный счёт разрывов разошёлся бы с показом на первом
// же инертном разрыве.
function pageOf(blocks: readonly Block[], blockId: string): number {
  const opens = pageNumbers([...blocks])
  let page = 1
  for (const b of blocks) {
    if (b.id === blockId) return page
    page = opens.get(b.id) ?? page
  }
  return page
}

// Цели перехода для блока `logic`: страницы ПОСЛЕ той, на которой он стоит, плюс
// «к отправке». Переход назад инертен по построению обхода, и показывать его в списке
// значило бы пообещать работу, которой не будет.
//
// СТРАНИЦА «СПАСИБО» целью не бывает (2026-08-21): она стоит за отправкой, а не перед
// ней, и переход на неё увёл бы респондента мимо кнопки — ответ не ушёл бы вовсе.
// Дойти до конца формы умеет «К отправке» (JUMP_END), и второго способа сказать то же
// самое быть не должно. Правило, нацеленное на неё, инертно и получает предупреждение
// (logicBlockWarnings спрашивает цели здесь же).
export function jumpTargetsFrom(
  blocks: readonly Block[],
  logicId: string,
): { value: string; label: string }[] {
  const from = pageOf(blocks, logicId)
  const opens = pageNumbers([...blocks])
  const thankYou = thankYouOpener([...blocks])?.id
  const out: { value: string; label: string }[] = []
  for (const b of blocks) {
    const page = opens.get(b.id)
    if (b.type !== 'page_break' || page === undefined || page <= from) continue
    if (b.id === thankYou) continue
    out.push({ value: b.id, label: pageName(b, page) })
  }
  out.push({ value: JUMP_END, label: 'К отправке' })
  return out
}

// ДЕРЕВО ЦЕЛЕЙ: страница → вопрос → его СТРОКИ и варианты (образец — Tally). Отдельного
// действия «скрыть варианты» нет: одно «скрыть» прячет и вопрос целиком, и отдельную его
// строку, и отдельный вариант, а кто чем оказался, разбирает вычислитель по документу.
//
// Два уровня видимости, поэтому и два уровня дерева: голова группы значит ВЕСЬ вопрос,
// её дети — каждый сам себя (ADR §10, 2026-08-16).
//
// `glyphType` — ЧЕЙ глиф рисовать у пункта (GlyphName). Тип, а не готовая иконка: модель
// не рисует, она называет.
//
// ГЛИФ ЕСТЬ ТОЛЬКО У БЛОКА (решение владельца 2026-08-16), потому что глиф — свойство
// ТИПА, а тип есть только у блока. Отсюда `undefined` в двух местах: у группы (вопрос из
// нескольких блоков — не блок, его называет имя) и у варианта списка (вариант вообще не
// блок). Одинокий блок в дереве узлом и остаётся, глиф у него свой.
export type TargetNode = {
  id: string
  label: string
  glyphType?: BlockType
  children: { id: string; label: string; glyphType?: BlockType }[]
}

// Что можно взять целью у этого вида действия. Показ адресует ВОПРОС (голову группы) и
// варианты; обязательность — только отвечаемый блок, вариант обязательным не бывает.
export function targetTree(
  blocks: readonly Block[],
  kind: 'show' | 'hide' | 'require',
): { page: number; items: TargetNode[] }[] {
  const opens = pageNumbers([...blocks])
  const out: { page: number; items: TargetNode[] }[] = []
  let page = 1
  for (const [i, b] of blocks.entries()) {
    page = opens.get(b.id) ?? page
    const node = targetNode(blocks, b, i, kind)
    if (node === null) continue
    const last = out[out.length - 1]
    if (last && last.page === page) last.items.push(node)
    else out.push({ page, items: [node] })
  }
  return out
}

function targetNode(
  blocks: readonly Block[],
  b: Block,
  i: number,
  kind: 'show' | 'hide' | 'require',
): TargetNode | null {
  if (kind === 'require') {
    if (!isAnswerableType(b.type)) return null
    return { id: b.id, label: targetLabel(blocks, b), glyphType: b.type, children: [] }
  }
  // Голова группы: прячется вопрос целиком. Заголовок формы и разрыв страницы прятать
  // нельзя — первый скелет документа, а исчезающий разрыв означал бы, что число страниц
  // зависит от ответов ДВУМЯ разными способами (условный путь задают переходы).
  const isHead = b.groupId !== blocks[i - 1]?.groupId
  if (!isHead || b.type === 'logic' || b.type === 'form_title' || b.type === 'page_break') {
    return null
  }
  // Дети узла — ОСТАЛЬНЫЕ строки вопроса и варианты его списка. Голова в детях не
  // повторяется: она и есть сам узел, и выбрать её значит выбрать вопрос целиком.
  const rows = blocks.filter((x) => x.groupId === b.groupId && x.id !== b.id)
  const options = blocks
    .filter((x) => x.groupId === b.groupId && isChoiceType(x.type))
    .flatMap((x) => x.settings?.options ?? [])
  return {
    id: b.id,
    label: targetLabel(blocks, b),
    // Узел с блоками внутри — ГРУППА, и глифа у неё нет: тип есть у блока, а не у
    // вопроса. Одинокий блок (голое поле, заголовок раздела, картинка) — сам себе узел,
    // и глиф у него собственный.
    glyphType: rows.length === 0 ? b.type : undefined,
    children: [
      ...rows.map((x) => ({ id: x.id, label: rowLabel(x), glyphType: x.type })),
      // Вариант глифа не получает: он не блок, типа у него нет.
      ...options.map((o) => ({ id: o.id, label: o.label.trim() || 'Без названия' })),
    ],
  }
}

// Как называется СТРОКА внутри вопроса. Свой текст, если он есть; иначе имя типа из
// реестра редактора («Короткий ответ», «Картинка») — то же слово, которым строка зовётся
// в меню вставки. Имя ВОПРОСА здесь не годится: у поля оно то же, что у его подписи, и
// в дереве получились бы два одинаковых пункта.
function rowLabel(b: Block): string {
  return captionOf(b) || editorKind(b.type).label
}

// Совпадение по ОБОИМ уровням дерева: подошёл вопрос — показываем его со всеми
// вариантами; подошёл только вариант — показываем вопрос и подошедшие варианты, иначе
// автор не поймёт, к чему они относятся.
//
// Фильтр СВОЙ, а не cmdk: свёрнутый узел не отрисован, и его дети для чужого фильтра не
// существуют — поиск молча не находил бы половину документа.
export function filterTargetTree(
  tree: { page: number; items: TargetNode[] }[],
  query: string,
): { page: number; items: TargetNode[] }[] {
  const q = query.trim().toLowerCase()
  if (q === '') return tree
  const hit = (s: string): boolean => s.toLowerCase().includes(q)
  const out: { page: number; items: TargetNode[] }[] = []
  for (const { page, items } of tree) {
    const kept = items
      .map((n) => (hit(n.label) ? n : { ...n, children: n.children.filter((c) => hit(c.label)) }))
      .filter((n) => hit(n.label) || n.children.length > 0)
    if (kept.length > 0) out.push({ page, items: kept })
  }
  return out
}

// Почему правило блока не действует — ПРЕДУПРЕЖДЕНИЯ, а не отказ схемы: всё это
// кросс-блочное, и валидатор ловил бы 422 в автосейве от первого же драга. Причины
// условия даёт вычислитель (ruleWarnings — одна копия на всех, иначе разъедется);
// причины действий живут здесь, потому что «цель ниже блока» знает только редактор.
export function logicBlockWarnings(blocks: readonly Block[], block: Block): string[] {
  const when = block.logic?.when
  const actions = block.logic?.then ?? []
  const out: string[] = []
  // Условие проверяется ОТ КАЖДОЙ ЦЕЛИ: инертность меряется у неё, и правило, годное для
  // одной цели, может не годиться для другой — если цели стоят в разных местах
  // документа. У перехода и «скрыть кнопку» цель — страница, значит мерить от блока.
  const carriers = new Set<string>()
  for (const a of actions) {
    if (a.kind === 'jump' || a.kind === 'block_submit') carriers.add(block.id)
    else for (const id of a.targets) carriers.add(id)
  }
  if (actions.length === 0) carriers.add(block.id)
  for (const carrier of carriers) {
    for (const w of ruleWarnings(blocks, carrier, when)) out.push(w.reason)
  }

  for (const a of actions) {
    if (a.kind === 'block_submit') continue
    if (a.kind === 'jump') {
      const want = a.end === true ? JUMP_END : a.to
      if (jumpTargetsFrom(blocks, block.id).some((t) => t.value === want)) continue
      out.push('переход некуда вести — страницы ниже нет')
      continue
    }
    const optionIds = new Set(blocks.flatMap((b) => (b.settings?.options ?? []).map((o) => o.id)))
    for (const id of a.targets) {
      const target = blocks.find((b) => b.id === id)
      if (!target) {
        // Вариант — законная цель показа, но не обязательности.
        if (!optionIds.has(id)) out.push('цель удалена — действие не работает')
        else if (a.kind === 'require') out.push('вариант нельзя сделать обязательным')
        continue
      }
      if (a.kind === 'require' && target.required === true) {
        out.push(`«${targetLabel(blocks, target)}» обязателен всегда — условие ничего не меняет`)
      }
    }
  }
  // Дубли не показываем: две цели с одной бедой — одна строка, а не две.
  return [...new Set(out)]
}

export const ACTION_LABELS: Record<LogicActionKind, string> = {
  show: 'Показать',
  hide: 'Скрыть',
  require: 'Сделать обязательным',
  jump: 'Перейти на страницу',
  block_submit: 'Скрыть кнопку отправки',
}

// Подпись вопроса для источника, у которого имя не задано, выводит derivedQuestionName;
// здесь — только текст блока-подписи, если он нужен отдельно (подсказки редактора).
export function captionOf(block: Block): string {
  return plainText(block.text).trim()
}
