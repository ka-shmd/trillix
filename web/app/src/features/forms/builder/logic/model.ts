import {
  type Block,
  type LogicActionKind,
  type LogicCondition,
  type LogicOperator,
  isAnswerableType,
  isChoiceType,
  opNeedsValue,
  plainText,
  scaleRange,
} from '@entities/formSchema'
import { pageNumbers } from '@fields/groups'
import { operatorsFor, ruleWarnings } from '@fields/logic'

import { derivedQuestionName } from '../questionName'

// Правила РЕДАКТОРА условной логики (фаза 21): кто носитель правила, из чего автор
// выбирает источник, как правило называется одной строкой. Семантику (что правило
// значит и когда оно инертно) знает вычислитель @fields/logic — здесь её нет и не
// должно быть: вторая копия разъехалась бы с первой.

// Носитель `visibleIf` — ГОЛОВНОЙ блок группы: прячется вопрос целиком (подпись, поле,
// контент), как и бит ряда, живущий там же. Попап адресован полю, поэтому носителя
// приходится искать — сам блок им может и не быть.
export function ruleCarrier(blocks: readonly Block[], blockId: string): Block | null {
  const block = blocks.find((b) => b.id === blockId)
  if (!block) return null
  return blocks.find((b) => b.groupId === block.groupId) ?? null
}

// Из чего автор выбирает источник: отвечаемые вопросы ВЫШЕ носителя. Ниже стоящие не
// предлагаем вовсе — правило по ним инертно, и показать такой выбор значило бы
// пообещать работу, которой не будет (о правилах, ставших инертными от перестановки,
// предупреждает ruleWarnings).
export function sourcesFor(blocks: readonly Block[], carrierId: string): Block[] {
  const at = blocks.findIndex((b) => b.id === carrierId)
  if (at < 0) return []
  return blocks.slice(0, at).filter((b) => isAnswerableType(b.type))
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

// Группа условий — узел с детьми. Корень правила редактор всегда держит группой (два
// способа выразить одно правило означали бы две ветки в каждой его операции), поэтому
// одинокий лист из чужого документа заворачивается на чтении, а не мигрируется в схеме.
export type Group = { all: LogicCondition[] } | { any: LogicCondition[] }

export function asRootGroup(cond: LogicCondition): Group {
  return 'all' in cond || 'any' in cond ? cond : { all: [cond] }
}

// Обязательность — ТРИ состояния, а не два флага (ADR §10): нет / всегда / по условию.
// Схема запрещает required и requiredIf вместе, поэтому патч всегда чистит второе поле:
// иначе автосейв ловил бы 422 на первом же переключении.
export type RequiredMode = 'no' | 'always' | 'conditional'

export function requiredMode(block: Block): RequiredMode {
  if (block.requiredIf) return 'conditional'
  return block.required ? 'always' : 'no'
}

// Патч перехода в режим. У 'conditional' условие приходит извне: его выбирает автор в
// диалоге, а до первого условия режим не включается вовсе — правило без условий
// невалидно, и «обязателен по пустому условию» ничего не значит.
export function requiredPatch(
  mode: RequiredMode,
  cond?: LogicCondition,
): { required?: boolean; requiredIf?: LogicCondition } {
  if (mode === 'always') return { required: true, requiredIf: undefined }
  if (mode === 'no') return { required: false, requiredIf: undefined }
  return { required: false, requiredIf: cond }
}

export const OPERATOR_LABELS: Record<LogicOperator, string> = {
  answered: 'отвечен',
  empty: 'не отвечен',
  is: 'равен',
  is_not: 'не равен',
  includes: 'содержит',
  excludes: 'не содержит',
  gt: 'больше',
  lt: 'меньше',
}

// Правило одной строкой — для строки попапа и подсказки бейджа на полотне. Показывает
// ПЕРВОЕ условие и число остальных: полный текст не поместится ни там, ни там, а
// «показывать, если» без единого намёка на содержание бесполезно.
export function ruleSummary(blocks: readonly Block[], cond: LogicCondition | undefined): string {
  if (cond === undefined) return 'всегда'
  const leaves: { blockId: string; op: LogicOperator; value?: string }[] = []
  const walk = (c: LogicCondition): void => {
    if ('all' in c) c.all.forEach(walk)
    else if ('any' in c) c.any.forEach(walk)
    else leaves.push(c)
  }
  walk(cond)

  const first = leaves[0]
  if (!first) return 'всегда'
  const src = blocks.find((b) => b.id === first.blockId)
  const name = src ? sourceLabel(blocks, src) : 'удалённый вопрос'
  const op = OPERATOR_LABELS[first.op]
  const value = opNeedsValue(first.op) ? valueTitle(src, first.value ?? '') : ''
  const head = [name, op, value].filter(Boolean).join(' ')
  return leaves.length > 1 ? `${head} и ещё ${leaves.length - 1}` : head
}

// ПЕРЕХОДЫ МЕЖДУ СТРАНИЦАМИ (фаза 21, слайс 5).
//
// Цель перехода — разрыв, ОТКРЫВАЮЩИЙ страницу; нумерация берётся из pageNumbers, того
// же разбиения, которым форма режется респонденту (собственный счёт разрывов разошёлся
// бы с показом на первом же инертном разрыве).
//
// Предлагаются только цели ВПЕРЁД: переход назад инертен по построению обхода
// (@fields/logic), и показать его в списке значило бы пообещать работу, которой не будет.
export function jumpTargets(
  blocks: readonly Block[],
  breakId: string,
): { value: string; label: string }[] {
  const opens = pageNumbers([...blocks])
  const from = opens.get(breakId)
  const out: { value: string; label: string }[] = []
  if (from === undefined) return out // инертный разрыв: страницы не открывает, вести некуда
  for (const b of blocks) {
    const page = opens.get(b.id)
    if (b.type !== 'page_break' || page === undefined || page <= from) continue
    out.push({ value: b.id, label: `Страница ${page}` })
  }
  out.push({ value: JUMP_END, label: 'К отправке' })
  return out
}

// Значение поля `to`, означающее «страниц дальше нет». В схеме это отдельный флаг `end`,
// а не строка: id блока генерирует клиент, и 'end' — сам по себе законный id. В UI
// удобнее одно поле выбора, поэтому здесь строка-маркер, а на запись она разворачивается
// в правильную форму (см. JumpDialog).
export const JUMP_END = '\u0000end'

// Как переход читается одной строкой — для пункта попапа: цель плюс первое условие.
export function jumpSummary(blocks: readonly Block[], block: Block): string {
  const rules = block.jumpIf ?? []
  const first = rules[0]
  if (!first) return 'нет'
  const opens = pageNumbers([...blocks])
  const target = first.end === true ? 'к отправке' : `на страницу ${opens.get(first.to ?? '') ?? '?'}`
  const head = `${target}, если ${ruleSummary(blocks, first.when)}`
  return rules.length > 1 ? `${head} +${rules.length - 1}` : head
}

// ЦЕЛИ ДЕЙСТВИЙ БЛОКА `logic`. Зеркальны источникам: источник обязан стоять ВЫШЕ блока,
// цель — НИЖЕ него (ADR §10). Ниже стоящее и предлагаем; о правилах, обездвиженных
// перестановкой, предупреждает ruleWarnings.

// Голова группы — то, что адресуют «показать»/«скрыть»: прячется вопрос целиком.
// Группа смежна по инварианту схемы, поэтому голова — первый блок своего groupId.
function groupHeads(blocks: readonly Block[]): Block[] {
  return blocks.filter((b, i) => b.type !== 'logic' && b.groupId !== blocks[i - 1]?.groupId)
}

function below(blocks: readonly Block[], logicId: string): Block[] {
  const at = blocks.findIndex((b) => b.id === logicId)
  return at < 0 ? [] : blocks.slice(at + 1)
}

export function showTargets(blocks: readonly Block[], logicId: string): Block[] {
  const tail = below(blocks, logicId)
  const heads = new Set(groupHeads(blocks).map((b) => b.id))
  return tail.filter((b) => heads.has(b.id))
}

// Обязательным можно сделать только отвечаемый блок — у подписи и контента ответа нет.
export function requireTargets(blocks: readonly Block[], logicId: string): Block[] {
  return below(blocks, logicId).filter((b) => isAnswerableType(b.type))
}

// Варианты бывают только у choice-вопроса.
export function optionTargets(blocks: readonly Block[], logicId: string): Block[] {
  return below(blocks, logicId).filter((b) => isChoiceType(b.type))
}

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
export function jumpTargetsFrom(
  blocks: readonly Block[],
  logicId: string,
): { value: string; label: string }[] {
  const from = pageOf(blocks, logicId)
  const opens = pageNumbers([...blocks])
  const out: { value: string; label: string }[] = []
  for (const b of blocks) {
    const page = opens.get(b.id)
    if (b.type !== 'page_break' || page === undefined || page <= from) continue
    out.push({ value: b.id, label: `Страница ${page}` })
  }
  out.push({ value: JUMP_END, label: 'К отправке' })
  return out
}

// Почему правило блока не действует — ПРЕДУПРЕЖДЕНИЯ, а не отказ схемы: всё это
// кросс-блочное, и валидатор ловил бы 422 в автосейве от первого же драга. Причины
// условия даёт вычислитель (ruleWarnings — одна копия на всех, иначе разъедется);
// причины действий живут здесь, потому что «цель ниже блока» знает только редактор.
export function logicBlockWarnings(blocks: readonly Block[], block: Block): string[] {
  const out = ruleWarnings(blocks, block.id, block.logic?.when).map((w) => w.reason)
  const at = blocks.findIndex((b) => b.id === block.id)
  const heads = new Set(
    blocks.filter((b, i) => b.groupId !== blocks[i - 1]?.groupId).map((b) => b.id),
  )

  for (const a of block.logic?.then ?? []) {
    if (a.kind === 'block_submit') continue
    if (a.kind === 'jump') {
      if (jumpTargetsFrom(blocks, block.id).some((t) => t.value === (a.end === true ? JUMP_END : a.to))) {
        continue
      }
      out.push('переход некуда вести — страницы ниже нет')
      continue
    }
    const target = blocks.find((b) => b.id === a.target)
    if (!target) {
      out.push('цель удалена — действие не работает')
      continue
    }
    if (blocks.indexOf(target) <= at) {
      out.push(`«${targetLabel(blocks, target)}» стоит выше блока — действие не работает`)
      continue
    }
    if ((a.kind === 'show' || a.kind === 'hide') && !heads.has(target.id)) {
      out.push(`«${targetLabel(blocks, target)}» не первая строка вопроса — действие не работает`)
      continue
    }
    if (a.kind === 'require' && target.required === true) {
      out.push(`«${targetLabel(blocks, target)}» обязателен всегда — условие ничего не меняет`)
      continue
    }
    if ((a.kind === 'show_options' || a.kind === 'hide_options') && a.options.length === 0) {
      out.push('не выбрано ни одного варианта')
    }
  }
  // Дубли не показываем: два действия с одной бедой — одна строка, а не две.
  return [...new Set(out)]
}

export const ACTION_LABELS: Record<LogicActionKind, string> = {
  show: 'Показать',
  hide: 'Скрыть',
  require: 'Сделать обязательным',
  show_options: 'Показать варианты',
  hide_options: 'Скрыть варианты',
  jump: 'Перейти на страницу',
  block_submit: 'Скрыть кнопку отправки',
}

// Значение глазами автора: у списка это подпись варианта, а не его id.
function valueTitle(source: Block | undefined, value: string): string {
  if (!source || value === '') return value
  const option = valueChoices(source).find((c) => c.value === value)
  return option ? option.label : value
}

// Подпись вопроса для источника, у которого имя не задано, выводит derivedQuestionName;
// здесь — только текст блока-подписи, если он нужен отдельно (подсказки редактора).
export function captionOf(block: Block): string {
  return plainText(block.text).trim()
}
