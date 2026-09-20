import { z } from 'zod'

import { logicOperatorSchema, type BlockType, type LogicOperator } from '@entities/formSchema'
import { operatorsFor } from '@fields/logic'

// Фильтр ответов аналитики (спека design/analytics-v2.md §6.2): условия через «И»,
// условие — лист условия логики формы. В адресе и в запросе — параметр `where`:
// base64url без выравнивания от JSON-массива условий. Разбирает и проверяет его
// сервер (domain.ParseAnswerFilter) — здесь только упаковка.
//
// Живёт в shared: фильтр читают запросы сводки и её окна «все ответы», а экран
// аналитики собирает его из вопросов сводки.

const filterConditionSchema = z.object({
  blockId: z.string(),
  op: logicOperatorSchema,
  value: z.string().optional(),
})
export type FilterCondition = z.infer<typeof filterConditionSchema>

export const MAX_FILTER_CONDITIONS = 10 // зеркалит domain.MaxFilterConditions

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function encodeFilter(conditions: FilterCondition[]): string | undefined {
  return conditions.length === 0 ? undefined : toBase64Url(JSON.stringify(conditions))
}

// Условия из адреса. Битый параметр — фильтра нет: ссылку могли обрезать при
// пересылке, и экран без фильтра честнее экрана ошибки.
export function decodeFilter(raw: string | undefined): FilterCondition[] {
  if (!raw) return []
  try {
    return z.array(filterConditionSchema).parse(JSON.parse(fromBase64Url(raw)))
  } catch {
    return []
  }
}

export function filterFromSearch(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

export function needsValue(op: LogicOperator): boolean {
  return op !== 'answered' && op !== 'empty'
}

// Оператор равенства для типа вопроса: у множественного выбора «равен» значит «в
// ответе есть этот вариант» (`includes`), у остальных — `is`. Нужен там, где
// оператор не выбирают, а подразумевают: выбор варианта в списке выборки и щелчок
// по строке распределения.
//
// Спрашивает operatorsFor (@fields/logic), а не повторяет его правило: вторая копия
// «кому что предлагается» разъехалась бы с редактором логики и давала бы условия,
// которые сервер отвергает.
export function equalsOp(type: BlockType): LogicOperator {
  return operatorsFor(type).includes('is') ? 'is' : 'includes'
}

// Условие, добавленное к уже применённым. Правило одно на все входы (окно выборки и
// щелчок по строке распределения), потому что расхождение между ними человек читает
// как случайность.
//
// УСЛОВИЕ НА ПАРУ «ВОПРОС + ОПЕРАТОР» ОДНО. «Город равен Москве И город равен
// Петербургу» не сужает выборку, а обнуляет её: у ответа один город. Поэтому второе
// равенство по тому же вопросу ЗАМЕНЯЕТ первое, а повторное то же самое — снимает
// (щелчок по применённой строке гасит её).
//
// Разные операторы по одному вопросу при этом складываются: «оценка больше 3 И
// оценка меньше 8» — это диапазон, и ломать его нельзя.
export function withCondition(
  list: FilterCondition[],
  next: FilterCondition,
): FilterCondition[] {
  const i = list.findIndex((c) => c.blockId === next.blockId && c.op === next.op)
  if (i >= 0) {
    if (list[i]!.value === next.value) return list.filter((_, j) => j !== i)
    return list.map((c, j) => (j === i ? next : c))
  }
  // Потолок держит сервер (domain.MaxFilterConditions); условие сверх него не
  // применяется — иначе запрос вернул бы 422 на действие, которое выглядело обычным.
  if (list.length >= MAX_FILTER_CONDITIONS) return list
  return [...list, next]
}

// Чем сужена пустая выборка. Сервер отдаёт `unfiltered` при ЛЮБОЙ непустой выборке
// (domain.AnswerScope) — и при фильтре, и при одном сегменте, поэтому текст «сбросьте
// фильтр» при выбранном сегменте отсылал бы к пустой панели условий.
export function emptyScopeHint(filtered: boolean, segmented: boolean): string {
  if (filtered && segmented) return 'Измените условия фильтра или выберите другой сегмент.'
  if (segmented) return 'Выберите другой сегмент или сбросьте его.'
  return 'Измените условия фильтра или сбросьте его.'
}
