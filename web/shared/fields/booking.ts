import { createContext, useContext } from 'react'

// Как вопрос о записи получает свободное время (фаза 27, docs/design/booking.md).
//
// Тот же приём, что у загрузчика файлов (fileUpload.ts), и по той же причине: контрол
// живёт в @fields и общий для трёх поверхностей, а выдача времени требует того, чего у
// контрола нет и быть не должно — адреса формы, токена разблокировки и знания о
// холдах. Поэтому источник приходит КОНТЕКСТОМ: рендерер кладёт настоящий, полотно
// редактора и печатный лист — ничего.
//
// Отсутствие источника — не ошибка, а состояние: на полотне и в печати вопрос рисуется
// плашкой с выбранным временем (или приглашением), и живого выбора там нет.

// FreeSlot — свободная точка старта, как её отдаёт публичная ручка: момент времени в
// UTC и сколько мест ещё можно взять.
export type FreeSlot = { startsAt: string; remaining: number }

// SlotSource — всё, что нужно вопросу о записи: факты расписания и две операции.
export type SlotSource = {
  // timezone — пояс РАСПИСАНИЯ. Респондент видит время в своём (его даёт браузер), но
  // подпись обязана назвать оба, когда они разные: «11:00 у вас, 13:00 у мастера».
  timezone: string
  // maxSeats — сколько мест можно взять одной записью. 1 — выбора мест нет вовсе.
  maxSeats: number
  // showRemaining — рисовать ли остаток мест. Настройка автора; само число приезжает
  // всегда, иначе пикер не погасит слот, куда запрошенные места не влезают.
  showRemaining: boolean
  // list — свободное время на отрезке. Отменяемый: респондент листает даты быстрее,
  // чем отвечает сеть.
  list: (args: { from: string; to: string; signal: AbortSignal }) => Promise<FreeSlot[]>
  // hold — придержать время, пока человек заполняет анкету. Возвращает id брони: он и
  // есть ответ на вопрос (design/booking.md §5.6).
  hold: (args: { startsAt: string; seats: number }) => Promise<{ bookingId: string }>
}

const SlotSourceContext = createContext<SlotSource | null>(null)

export const SlotSourceProvider = SlotSourceContext.Provider

// useSlotSource — источник свободного времени; null там, где живого выбора нет.
export function useSlotSource(): SlotSource | null {
  return useContext(SlotSourceContext)
}

// HOLD_CONFLICT — код, которым источник сообщает «время только что заняли». Строкой, а
// не HTTP-статусом: контрол про HTTP не знает, а текст отказа у него свой.
export const HOLD_CONFLICT = 'slot_taken'
// HOLD_NO_SEATS — мест меньше, чем запросили.
export const HOLD_NO_SEATS = 'slot_seats'
