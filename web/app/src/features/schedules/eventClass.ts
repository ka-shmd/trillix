import type { Booking, ScheduleBlock, TimeWindow } from '../../entities/schedule'
import { formTone } from './formColor'

// Каким классом красится событие полотна.
//
// ЖИВЁТ ОТДЕЛЬНЫМ ЧИСТЫМ МОДУЛЕМ, чтобы проверяться тестом. Сборка сюда не смотрит:
// имя класса собирается строкой, и потерянный кусок этой строки ничего не ломает —
// ни типы, ни тесты, ни сборку. Ровно так уехал префикс `sc-tone-`, и записи на
// полотне вышли белыми (отчёт владельца 2026-09-05): класс получался
// `sc-ev sc-booking 3`, и правила тонов не совпадали ни с чем.
//
// Строкой, а не списком: опция библиотеки принимает одно имя класса
// (`ClassNameInput`), и массив молча не доехал бы.

// EventProps — что полотно знает о своём событии. Слой обязателен: обработчики
// приходят одни на все четыре, и различать их по виду события нечем.
export type EventProps =
  | {
      layer: 'availability'
      date: string
      window: TimeWindow
      source: string
      // editing — окно принадлежит дню, часы которого правят прямо сейчас. Лежит в
      // самом событии, потому что вид красит эта функция, а до состояния экрана она
      // не дотягивается.
      editing: boolean
    }
  | { layer: 'block'; block: ScheduleBlock }
  | { layer: 'booking'; booking: Booking }

export function eventClass(info: { event: { extendedProps: Record<string, unknown> } }): string {
  const props = info.event.extendedProps as EventProps | undefined
  // ⚠ СОБЫТИЕ БЕЗ СЛОЯ — ЧУЖОЕ: мираж перетаскивания, который библиотека рисует сама.
  // До правки оно проваливалось в ветку записи и вылезало на полотне синей кляксой
  // (отчёт владельца 2026-09-04). Своего вида у чужого события быть не должно.
  if (!props?.layer) return 'sc-ev sc-ghost'
  if (props.layer === 'availability') {
    const source = props.source === 'exception' ? 'sc-av-ex' : 'sc-av-weekly'
    // Правимый день выделен и на самой полосе: режим, который виден только по
    // открытому меню, автор забудет закрыть.
    return `sc-ev sc-av ${source}${props.editing ? ' sc-av-edit' : ''}`
  }
  if (props.layer === 'block') return 'sc-ev sc-block'
  // ЧЬЯ ЭТО ФОРМА — тем же тоном и тем же способом, что в списке ближайших
  // (`formColor.ts`): одно расписание обслуживает несколько форм, и на полотне они
  // шли вперемешку одним цветом. Номер тона считает общая функция, а «номер → токен»
  // живёт в `canvas.css` — цвет красится классом, а не значением в данных.
  return `sc-ev sc-booking sc-tone-${formTone(props.booking.formId)}`
}
