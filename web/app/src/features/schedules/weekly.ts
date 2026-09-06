import {
  MAX_WINDOWS_PER_DAY,
  WEEKDAYS,
  type Availability,
  type TimeWindow,
  type Weekday,
} from '../../entities/schedule'

// Арифметика и проверки недельного правила — чистые функции над документом
// availability. Правит его теперь полотно недели (canvasEdit.ts), а здесь остаётся
// то, что нужно и полотну, и списку расписаний.
//
// ЗЕРКАЛО СЕРВЕРА, А НЕ ЗАМЕНА ЕМУ: те же проверки написаны в Go
// (domain.ValidateAvailability) и решают именно там (инвариант 3). Здесь они нужны
// затем, чтобы автор увидел «окна пересекаются» сразу, а не 422 после сохранения.

// clockToMinutes — «10:00» → 600. null, если это не время суток. «24:00» законно
// концом окна: рабочий день до полуночи иначе невыразим.
export function clockToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

// windowsError — что не так с окнами дня, человеческими словами. null = всё в
// порядке. Порядок проверок тот же, что в Go, чтобы текст под строкой и текст 422
// говорили об одном и том же.
export function windowsError(windows: TimeWindow[]): string | null {
  if (windows.length > MAX_WINDOWS_PER_DAY) {
    return `Не больше ${MAX_WINDOWS_PER_DAY} окон в дне`
  }
  let prevEnd = -1
  for (const w of windows) {
    const from = clockToMinutes(w.from)
    const to = clockToMinutes(w.to)
    if (from === null || to === null) return 'Время указано неверно'
    if (from >= to) return 'Конец окна должен быть позже начала'
    if (from < prevEnd) return 'Окна пересекаются или идут не по порядку'
    prevEnd = to
  }
  return null
}

export function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function dayWindows(a: Availability, day: Weekday): TimeWindow[] {
  return a.weekly[day] ?? []
}

// weekSummary — правило одной строкой для списка расписаний: «пн–пт, 10:00–18:00».
//
// Подряд идущие дни с ОДИНАКОВЫМИ окнами сворачиваются в диапазон: «пн, вт, ср, чт,
// пт» — тот же список, только длиннее.
export function weekSummary(a: Availability): string {
  const groups: { days: Weekday[]; hours: string }[] = []
  for (const day of WEEKDAYS) {
    const windows = dayWindows(a, day)
    if (windows.length === 0) continue
    const hours = windows.map((w) => `${w.from}–${w.to}`).join(', ')
    const last = groups[groups.length - 1]
    // Диапазон продолжается, только если дни идут ПОДРЯД: «пн, ср» с одинаковыми
    // часами — это два дня, а не «пн–ср».
    const adjacent =
      last && WEEKDAYS.indexOf(last.days[last.days.length - 1]!) === WEEKDAYS.indexOf(day) - 1
    if (last && last.hours === hours && adjacent) last.days.push(day)
    else groups.push({ days: [day], hours })
  }
  if (groups.length === 0) return 'Приём не ведётся'
  return groups
    .map((g) => {
      const from = WEEKDAY_SHORT[g.days[0]!]
      const to = WEEKDAY_SHORT[g.days[g.days.length - 1]!]
      return `${g.days.length === 1 ? from : `${from}–${to}`}, ${g.hours}`
    })
    .join(' · ')
}

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: 'пн',
  tue: 'вт',
  wed: 'ср',
  thu: 'чт',
  fri: 'пт',
  sat: 'сб',
  sun: 'вс',
}

// clampSeats — сколько мест можно взять одной записью при такой вместимости.
//
// ⚠ ПРАВИЛО ЖИВЁТ ЗДЕСЬ, А НЕ В РАЗМЕТКЕ, потому что поле СКРЫТО при вместимости 1
// (решение владельца 2026-09-03): «взять два места из одного» невыразимо, и строка с
// таким выбором стоит на экране мёртвой. Но спрятать поле мало — в документе оно
// остаётся, и расписание, у которого вместимость снизили с восьми до одного, ушло бы
// на сервер с maxSeatsPerBooking = 3 и получило 422 про поле, которого автор не видит.
//
// Поэтому значение ЗАЖИМАЕТСЯ вместимостью всегда, и зажим считается там же, где
// меняется вместимость.
export function clampSeats(seats: number, capacity: number): number {
  if (capacity < 1) return 1
  if (seats < 1) return 1
  return Math.min(seats, capacity)
}
