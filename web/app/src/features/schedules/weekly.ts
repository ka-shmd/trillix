import {
  MAX_WINDOWS_PER_DAY,
  WEEKDAYS,
  WEEKDAYS_WORKING,
  type Availability,
  type TimeWindow,
  type Weekday,
} from '../../entities/schedule'

// Правка недельного правила — чистые функции над документом availability.
//
// ЗЕРКАЛО СЕРВЕРА, А НЕ ЗАМЕНА ЕМУ: те же проверки написаны в Go
// (domain.ValidateAvailability) и решают именно там (инвариант 3). Здесь они нужны
// затем, чтобы автор увидел «окна пересекаются» под строкой дня, а не 422 после
// нажатия «Сохранить».

// Окно по умолчанию у включённого дня — рабочий день. Оно же стоит в умолчаниях
// нового расписания, и разъезжаться им нельзя.
export const DEFAULT_WINDOW: TimeWindow = { from: '10:00', to: '18:00' }

export function dayWindows(a: Availability, day: Weekday): TimeWindow[] {
  return a.weekly[day] ?? []
}

// Приём в этот день ведётся — то есть у дня есть хоть одно окно. Отдельного
// тумблера в документе нет намеренно: «выключен» и «окон нет» — одно состояние,
// и второе представление рано или поздно разъехалось бы с первым.
export function dayEnabled(a: Availability, day: Weekday): boolean {
  return dayWindows(a, day).length > 0
}

export function setDayWindows(a: Availability, day: Weekday, windows: TimeWindow[]): Availability {
  return { ...a, weekly: { ...a.weekly, [day]: windows } }
}

export function toggleDay(a: Availability, day: Weekday, on: boolean): Availability {
  return setDayWindows(a, day, on ? [{ ...DEFAULT_WINDOW }] : [])
}

// addWindow добавляет окно ПОСЛЕ последнего: перерыв ставят после рабочего куска,
// и новое окно, встающее в начало, пришлось бы каждый раз переносить.
export function addWindow(a: Availability, day: Weekday): Availability {
  const windows = dayWindows(a, day)
  if (windows.length >= MAX_WINDOWS_PER_DAY) return a
  const last = windows[windows.length - 1]
  const next = last ? nextWindowAfter(last) : { ...DEFAULT_WINDOW }
  return setDayWindows(a, day, [...windows, next])
}

export function removeWindow(a: Availability, day: Weekday, index: number): Availability {
  return setDayWindows(
    a,
    day,
    dayWindows(a, day).filter((_, i) => i !== index),
  )
}

export function setWindow(
  a: Availability,
  day: Weekday,
  index: number,
  window: TimeWindow,
): Availability {
  return setDayWindows(
    a,
    day,
    dayWindows(a, day).map((w, i) => (i === index ? window : w)),
  )
}

// copyToWorkdays повторяет окна дня на пн–пт. Без этой кнопки автор заполняет одно
// и то же пять раз; суббота и воскресенье не трогаются — их правят отдельно, и чаще
// всего они пустые.
export function copyToWorkdays(a: Availability, from: Weekday): Availability {
  const windows = dayWindows(a, from)
  const weekly = { ...a.weekly }
  for (const day of WEEKDAYS_WORKING) {
    weekly[day] = windows.map((w) => ({ ...w }))
  }
  return { ...a, weekly }
}

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

// availabilityError — первая беда всего правила, с именем дня. Экран показывает её
// у кнопки сохранения: сохранять документ, который сервер отвергнет, незачем.
export function availabilityError(a: Availability): { day: Weekday; message: string } | null {
  for (const day of Object.keys(a.weekly) as Weekday[]) {
    const err = windowsError(a.weekly[day] ?? [])
    if (err) return { day, message: err }
  }
  return null
}

// nextWindowAfter — где встать новому окну: час после конца предыдущего, длиной в
// час. Смысл в том, чтобы окно появилось ГОДНЫМ (без пересечения), а не требовало
// правки обеих границ сразу же.
function nextWindowAfter(last: TimeWindow): TimeWindow {
  const end = clockToMinutes(last.to) ?? 0
  const from = Math.min(end + 60, 23 * 60)
  const to = Math.min(from + 60, 24 * 60)
  return { from: minutesToClock(from), to: minutesToClock(to) }
}

export function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// weekSummary — правило одной строкой для списка расписаний: «пн–пт, 10:00–18:00».
//
// Подряд идущие дни с ОДИНАКОВЫМИ окнами сворачиваются в диапазон: список из семи
// строк на карточке нечитаем, а «пн, вт, ср, чт, пт» вместо «пн–пт» — тот же список,
// только длиннее.
export function weekSummary(a: Availability): string {
  const groups: { days: Weekday[]; hours: string }[] = []
  for (const day of WEEKDAYS) {
    const windows = dayWindows(a, day)
    if (windows.length === 0) continue
    const hours = windows.map((w) => `${w.from}–${w.to}`).join(', ')
    const last = groups[groups.length - 1]
    // Диапазон продолжается, только если дни идут ПОДРЯД: «пн, ср» с одинаковыми
    // часами — это два дня, а не «пн–ср».
    const adjacent = last && WEEKDAYS.indexOf(last.days[last.days.length - 1]!) === WEEKDAYS.indexOf(day) - 1
    if (last && last.hours === hours && adjacent) last.days.push(day)
    else groups.push({ days: [day], hours })
  }
  if (groups.length === 0) return 'Приём не ведётся'
  return groups
    .map((g) => {
      const from = WEEKDAY_SHORT[g.days[0]!]
      const to = WEEKDAY_SHORT[g.days[g.days.length - 1]!]
      const days = g.days.length === 1 ? from : `${from}–${to}`
      return `${days}, ${g.hours}`
    })
    .join(' · ')
}

const WEEKDAY_SHORT: Record<Weekday, string> = {
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
