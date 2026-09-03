import { z } from 'zod'

import { HOLD_CONFLICT, HOLD_NO_SEATS, type FreeSlot, type SlotSource } from '@fields/booking'

import { unlockHeaders } from './unlock'

// Свободное время формы — сторона рендерера (фаза 27). Контрол про HTTP не знает: он
// получает две функции контекстом (@fields/booking), а адрес формы, токен разблокировки
// и разбор отказов живут здесь.
//
// Файл ЕДЕТ В ОБЩЕМ БАНДЛЕ, в отличие от самого пикера: источник надо собрать до того,
// как станет ясно, нужен ли выбор, — зато весит он полсотни строк.

const freeSlotSchema = z.object({
  startsAt: z.string(),
  // remaining приезжает всегда: без него пикер не погасит слот, куда запрошенные места
  // не влезают. Показывать ли его человеку — решает showRemaining расписания.
  remaining: z.number().int(),
})

const slotsResponseSchema = z.object({ items: z.array(freeSlotSchema) })
const holdResponseSchema = z.object({ bookingId: z.string() })

// booking — факты расписания формы, приезжающие вместе со схемой. Нет поля — у формы
// нет записи, и вопрос о времени (если он в схеме) живого выбора не получит.
export const bookingFactsSchema = z.object({
  timezone: z.string(),
  maxSeats: z.number().int().min(1).default(1),
  showRemaining: z.boolean().default(false),
})
export type BookingFacts = z.infer<typeof bookingFactsSchema>

// makeSlotSource собирает источник для одной формы.
//
// clientId — тот же id, что уедет идентификатором ответа. По нему сервер держит бронь
// ОДНОЙ на клиента (0050): передумавший респондент переносит свою бронь, а не заводит
// вторую, — поэтому id обязан быть тем же самым, что придёт с ответом.
export function makeSlotSource(slug: string, facts: BookingFacts, clientId: string): SlotSource {
  return {
    timezone: facts.timezone,
    maxSeats: facts.maxSeats,
    showRemaining: facts.showRemaining,

    async list({ from, to, signal }) {
      const url =
        `/public/v1/forms/${encodeURIComponent(slug)}/slots` +
        `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...unlockHeaders(slug) },
        signal,
      })
      if (!res.ok) throw new Error(String(res.status))
      return slotsResponseSchema.parse(await res.json()).items as FreeSlot[]
    },

    async hold({ startsAt, seats }) {
      const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/slots/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...unlockHeaders(slug) },
        body: JSON.stringify({ startsAt, seats, clientId }),
      })
      // Отказы переводятся в КОДЫ, а не в тексты: тексты пишет контрол — их видит
      // клиент автора, и звучать они должны как извинение сервиса.
      if (res.status === 409) throw new Error(HOLD_CONFLICT)
      if (res.status === 422) throw new Error(HOLD_NO_SEATS)
      if (!res.ok) throw new Error(String(res.status))
      return holdResponseSchema.parse(await res.json())
    },
  }
}
