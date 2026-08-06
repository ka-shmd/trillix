import {
  type Block,
  type LogicCondition,
  type LogicOperator,
  isAnswerableType,
  isChoiceType,
  opNeedsValue,
  plainText,
  scaleRange,
} from '@entities/formSchema'
import { operatorsFor } from '@fields/logic'

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
