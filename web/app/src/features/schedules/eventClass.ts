import type { Booking, ScheduleBlock, TimeWindow } from '../../entities/schedule'
import { formTone } from './formColor'

// Каким классом красится событие полотна.
//
// ⚠ ОТДЕЛЬНЫЙ ЧИСТЫЙ МОДУЛЬ — чтобы проверяться тестом: имя класса собирается
// строкой, и потерянный кусок ничего не ломает ни в типах, ни в сборке. Так уехал
// префикс `sc-tone-`, и записи вышли белыми.
//
// Строкой, а не списком: опция библиотеки принимает одно имя (`ClassNameInput`).

// EventProps — что полотно знает о своём событии. Слой обязателен: обработчики
// приходят одни на все четыре, и различать их по виду события нечем.
export type EventProps =
  | {
      layer: 'availability'
      date: string
      window: TimeWindow
      source: string
    }
  | { layer: 'block'; block: ScheduleBlock }
  | { layer: 'booking'; booking: Booking }

export function eventClass(info: { event: { extendedProps: Record<string, unknown> } }): string {
  const props = info.event.extendedProps as EventProps | undefined
  // ⚠ СОБЫТИЕ БЕЗ СЛОЯ — ЧУЖОЕ: мираж перетаскивания, который библиотека рисует сама.
  // Своего вида у него быть не должно.
  if (!props?.layer) return 'sc-ev sc-ghost'
  if (props.layer === 'availability') {
    return `sc-ev sc-av ${props.source === 'exception' ? 'sc-av-ex' : 'sc-av-weekly'}`
  }
  if (props.layer === 'block') return 'sc-ev sc-block'
  // Чья это форма — тем же тоном, что в списке ближайших (`formColor.ts`). Номер
  // считает общая функция, «номер → токен» живёт в `canvas.css`.
  return `sc-ev sc-booking sc-tone-${formTone(props.booking.formId)}`
}
