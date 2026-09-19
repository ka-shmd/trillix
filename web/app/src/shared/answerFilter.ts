import { z } from 'zod'

import { logicOperatorSchema, type LogicOperator } from '@entities/formSchema'

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
