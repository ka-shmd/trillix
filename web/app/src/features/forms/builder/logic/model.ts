import {
  type Block,
  type LogicActionKind,
  type LogicCondition,
  type LogicOperator,
  isAnswerableType,
  isChoiceType,
  plainText,
  scaleRange,
} from '@entities/formSchema'
import { pageNumbers } from '@fields/groups'
import { operatorsFor, ruleWarnings } from '@fields/logic'

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

// Голова группы — то, что адресуют «показать»/«скрыть»: прячется вопрос целиком.
// Группа смежна по инварианту схемы, поэтому голова — первый блок своего groupId.
function groupHeads(blocks: readonly Block[]): Block[] {
  return blocks.filter((b, i) => b.type !== 'logic' && b.groupId !== blocks[i - 1]?.groupId)
}

export function showTargets(blocks: readonly Block[]): Block[] {
  // Заголовок формы и разрыв страницы прятать нельзя. Заголовок — скелет документа, а
  // не вопрос; исчезающий разрыв означал бы, что число страниц зависит от ответов ДВУМЯ
  // разными способами — условный путь задают переходы.
  return groupHeads(blocks).filter((b) => b.type !== 'form_title' && b.type !== 'page_break')
}

// Обязательным можно сделать только отвечаемый блок — у подписи и контента ответа нет.
export function requireTargets(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => isAnswerableType(b.type))
}

// Варианты бывают только у choice-вопроса.
export function optionTargets(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => isChoiceType(b.type))
}

// Цели, разложенные по страницам, — так их показывает пикер: список стал документом
// целиком, и без разбиения в нём не найтись. Номера берутся ТЕМ ЖЕ разбиением, которым
// форма режется респонденту (pageNumbers), иначе автор увидит страницы, которых нет.
export function targetsByPage(
  blocks: readonly Block[],
  targets: readonly Block[],
): { page: number; items: Block[] }[] {
  const opens = pageNumbers([...blocks])
  const wanted = new Set(targets.map((b) => b.id))
  const out: { page: number; items: Block[] }[] = []
  let page = 1
  for (const b of blocks) {
    page = opens.get(b.id) ?? page
    if (!wanted.has(b.id)) continue
    const last = out[out.length - 1]
    if (last && last.page === page) last.items.push(b)
    else out.push({ page, items: [b] })
  }
  return out
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
  const when = block.logic?.when
  const actions = block.logic?.then ?? []
  const out: string[] = []
  const heads = new Set(
    blocks.filter((b, i) => b.groupId !== blocks[i - 1]?.groupId).map((b) => b.id),
  )

  // Условие проверяется ОТ КАЖДОЙ ЦЕЛИ: инертность меряется у неё, и правило, годное для
  // одной цели, может не годиться для другой — если цели стоят в разных местах
  // документа. У перехода и «скрыть кнопку» цель — страница, значит мерить от блока.
  const carriers = new Set<string>()
  for (const a of actions) {
    carriers.add(a.kind === 'jump' || a.kind === 'block_submit' ? block.id : a.target)
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
    const target = blocks.find((b) => b.id === a.target)
    if (!target) {
      out.push('цель удалена — действие не работает')
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
  // Дубли не показываем: две цели с одной бедой — одна строка, а не две.
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

// Подпись вопроса для источника, у которого имя не задано, выводит derivedQuestionName;
// здесь — только текст блока-подписи, если он нужен отдельно (подсказки редактора).
export function captionOf(block: Block): string {
  return plainText(block.text).trim()
}
