import { type FreeSlot } from '../booking'

// Чистая часть пикера: как список свободных точек превращается в то, что видит
// респондент. Отдельно от компонента, потому что проверяется таблицей, а не глазами.

// SlotDay — один день выдачи: ключ (местная дата), подпись и времена этого дня.
export type SlotDay = {
  key: string
  label: string
  slots: FreeSlot[]
}

// groupByDay режет плоский список точек по МЕСТНЫМ суткам респондента.
//
// Сутки считаются в поясе того, кто смотрит, а не расписания: человек выбирает время
// своим календарём, и «четверг» для него — его четверг. Расписание при этом может быть
// в другом поясе — тогда одна и та же точка попадёт у автора и у респондента в разные
// дни, и это правильно.
export function groupByDay(slots: FreeSlot[], locale = 'ru-RU'): SlotDay[] {
  const days: SlotDay[] = []
  const index = new Map<string, SlotDay>()
  for (const slot of slots) {
    const at = new Date(slot.startsAt)
    if (Number.isNaN(at.getTime())) continue
    const key = dayKey(at)
    let day = index.get(key)
    if (!day) {
      day = { key, label: dayLabel(at, locale), slots: [] }
      index.set(key, day)
      days.push(day)
    }
    day.slots.push(slot)
  }
  // Точки внутри дня — по возрастанию: сервер отдаёт их упорядоченными, но полагаться
  // на чужой порядок в списке, который человек читает сверху вниз, не стоит.
  for (const day of days) {
    day.slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  }
  days.sort((a, b) => a.key.localeCompare(b.key))
  return days
}

// dayKey — местная дата «ГГГГ-ММ-ДД». Своя сборка, а не toISOString: тот отдаёт UTC, и
// вечерние слоты уехали бы в следующий день у всех, кто восточнее Гринвича.
function dayKey(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

function dayLabel(at: Date, locale: string): string {
  return at.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long' })
}

// timeLabel — время точки в поясе читателя.
export function timeLabel(startsAt: string, locale = 'ru-RU'): string {
  return new Date(startsAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

// zoneNote — подпись «время в вашем поясе», и она называет ЧУЖОЙ пояс только когда он
// отличается: одинаковые пояса — самый частый случай, и лишняя строка в нём объясняет
// то, чего человек не спрашивал.
export function zoneNote(scheduleZone: string, viewerZone = viewerTimeZone()): string | null {
  if (scheduleZone === '' || scheduleZone === viewerZone) return null
  return `Время указано в вашем часовом поясе (${viewerZone})`
}

// viewerTimeZone — пояс браузера. Наружу он НЕ отправляется (спека §6): им только
// подписывают время на экране.
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return ''
  }
}

// fits — влезает ли запрошенное число мест в остаток. Отдельной функцией: этим же
// правилом гасятся кнопки времени и проверяется отказ после смены числа мест.
export function fits(slot: FreeSlot, seats: number): boolean {
  return slot.remaining >= seats
}
