import { WEEKDAYS, type Availability, type TimeWindow, type Weekday } from '../../entities/schedule'
import { clockToMinutes, minutesToClock, WEEKDAY_SHORT } from './weekly'
import { LOCALE } from '../../shared/format'

// Слой часов приёма на полотне недели: правило и исключения → окна с ДАТАМИ.
//
// Считается на клиенте целиком, и это не оптимизация: документ правила экран уже
// держит (он же его и правит), а сервер про даты ничего нового не знает — свободное
// время формы считается из того же документа той же арифметикой (domain.FreeSlots).
// Ручка /calendar отдаёт только занятое — блокировки и брони.
//
// ВРЕМЯ ЗДЕСЬ — МЕСТНОЕ ВРЕМЯ РАСПИСАНИЯ, без пояса и без UTC. Полотно живёт в поясе
// расписания (`timeZone` календаря), и «наивная» строка `2026-09-16T10:00:00` в нём
// означает ровно то же, что «вторник, 10:00» в правиле. Поэтому арифметики поясов в
// этом файле нет вовсе — она нужна только блокировкам и броням (zone.ts), которые
// приезжают точками на оси времени.

// AvailabilitySpan — окно приёма на конкретной дате, как его рисует полотно.
export type AvailabilitySpan = {
  // Ключ даты в поясе расписания, ГГГГ-ММ-ДД.
  date: string
  window: TimeWindow
  // Откуда окно взялось: из недельного правила или из исключения по дате. Полотно
  // красит их по-разному — иначе автор не отличит «так каждую неделю» от «так
  // только в этот день», а это ровно то, что он и пришёл увидеть.
  source: 'weekly' | 'exception'
  // Наивное местное время для календаря.
  start: string
  end: string
}

// WEEKDAY_BY_JS — ключи дней в порядке Date.getUTCDay (воскресенье нулевое).
// Порядок WEEKDAYS недельный, с понедельника, и совпадением их считать нельзя.
const WEEKDAY_BY_JS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// weekdayOf — день недели КАЛЕНДАРНОЙ даты. Пояс не участвует: у даты как таковой
// день недели один во всём мире, и Date.UTC здесь — арифметика, а не момент времени.
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number)
  const js = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()
  return WEEKDAY_BY_JS[js] ?? 'mon'
}

// dateKeys — count календарных дат начиная с from. Через Date.UTC, потому что
// местная арифметика в браузере с переводом часов даёт 23- и 25-часовые сутки, и
// «плюс 24 часа» иногда возвращает ту же дату.
export function dateKeys(from: string, count: number): string[] {
  const [y, m, d] = from.split('-').map(Number)
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}

// effectiveWindows — часы приёма, действующие в этот день.
//
// ИСКЛЮЧЕНИЕ ПЕРЕБИВАЕТ ДЕНЬ ЦЕЛИКОМ, а не дополняет его (design/booking.md §5.2):
// пустой список окон в исключении — это «не принимаю», а не «правило не тронуто».
export function effectiveWindows(
  a: Availability,
  date: string,
): {
  windows: TimeWindow[]
  source: 'weekly' | 'exception'
} {
  const ex = a.exceptions.find((e) => e.date === date)
  if (ex) return { windows: ex.windows, source: 'exception' }
  return { windows: a.weekly[weekdayOf(date)] ?? [], source: 'weekly' }
}

// spansIn — часы приёма на перечисленных датах, готовые к отрисовке.
export function spansIn(a: Availability, dates: string[]): AvailabilitySpan[] {
  const out: AvailabilitySpan[] = []
  for (const date of dates) {
    const { windows, source } = effectiveWindows(a, date)
    for (const window of windows) {
      const span = toSpan(date, window)
      if (span) out.push({ date, window, source, ...span })
    }
  }
  return out
}

// toSpan — окно местного времени в пару наивных отметок календаря. null у неразбор-
// чивого окна: документ приезжает с сервера, и рисовать мусор молча нельзя.
//
// «24:00» — законный конец окна (рабочий день до полуночи иначе невыразим), но
// наивной отметки `T24:00:00` не бывает: конец переносится на полночь следующего дня.
function toSpan(date: string, w: TimeWindow): { start: string; end: string } | null {
  const from = clockToMinutes(w.from)
  const to = clockToMinutes(w.to)
  if (from === null || to === null || from >= to) return null
  const end =
    to === 24 * 60 ? `${dateKeys(date, 2)[1]}T00:00:00` : `${date}T${minutesToClock(to)}:00`
  return { start: `${date}T${minutesToClock(from)}:00`, end }
}

// dateOfNaive / clockOfNaive — обратный перевод: календарь возвращает наивные
// отметки того же вида, и разбирать их через Date значило бы пропустить их через
// пояс браузера.
export function dateOfNaive(naive: string): string {
  return naive.slice(0, 10)
}

export function clockOfNaive(naive: string): string {
  return naive.slice(11, 16)
}

// minutesOfNaive — минуты от полуночи ДАТЫ отсчёта. Полночь следующих суток даёт
// 1440: перетащенное на конец дня окно иначе схлопнулось бы в нулевое.
export function minutesOfNaive(naive: string, base: string): number {
  const day = dateOfNaive(naive)
  const minutes = clockToMinutes(clockOfNaive(naive)) ?? 0
  if (day === base) return minutes
  return minutes + 24 * 60 * dayDiff(base, day)
}

function dayDiff(from: string, to: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}

// WEEKDAY_EVERY — подпись области действия для чипа: «Каждый вторник».
export const WEEKDAY_EVERY: Record<Weekday, string> = {
  mon: 'Каждый понедельник',
  tue: 'Каждый вторник',
  wed: 'Каждую среду',
  thu: 'Каждый четверг',
  fri: 'Каждую пятницу',
  sat: 'Каждую субботу',
  sun: 'Каждое воскресенье',
}

// selectionRect — что автор выделил протяжкой: ПРЯМОУГОЛЬНИК, а не отрезок времени.
//
// Библиотека отдаёт непрерывный диапазон: протяжка со вторника на четверг это у неё
// «вторник с 10:00 до полуночи, среда целиком, четверг до 14:00». Для правила приёма
// это бессмыслица — правило описывает ЧАСЫ, а не одну длинную смену. Автор,
// протянувший мышь на соседнюю колонку, ждёт те же часы на каждом задетом дне
// (отчёт владельца 2026-09-04), и здесь отрезок пересчитывается в прямоугольник.
//
// null — выделение нулевой высоты (протяжка вбок ровно по горизонтали): создавать
// нечего.
export function selectionRect(
  startStr: string,
  endStr: string,
): { dates: string[]; window: TimeWindow } | null {
  const startDate = dateOfNaive(startStr)
  let lastDate = dateOfNaive(endStr)
  let endClock = clockOfNaive(endStr)
  // Конец выделения — граница ИСКЛЮЧИТЕЛЬНАЯ: протяжка до самого низа вторника
  // приезжает как «среда, 00:00». Без этой поправки она захватила бы лишнюю колонку,
  // а окно «до полуночи» стало бы нулевым.
  if (endClock === '00:00') {
    lastDate = shiftDate(lastDate, -1)
    endClock = '24:00'
  }
  const startClock = clockOfNaive(startStr)
  if (lastDate === startDate) {
    return startClock < endClock
      ? { dates: [startDate], window: { from: startClock, to: endClock } }
      : null
  }
  if (lastDate < startDate) return null
  const from = startClock < endClock ? startClock : endClock
  const to = startClock < endClock ? endClock : startClock
  if (from === to) return null
  const dates: string[] = []
  for (let d = startDate; d <= lastDate && dates.length < 62; d = shiftDate(d, 1)) dates.push(d)
  return { dates, window: { from, to } }
}

// bandBox — где нарисовать подсказку протяжки, в пикселях колонки.
//
// Колонка дня — это РОВНО ось часов (замерено: высота колонки совпадает с полной
// шкалой slotMinTime..slotMaxTime), поэтому пересчёт линейный. Высота приходит
// замером, а не считается из вёрстки: полотно бывает разной высоты, и вторая копия
// этого знания разъехалась бы с первой.
//
// null — окно вне видимой оси (правило шире показанных часов): рисовать нечего.
export function bandBox(
  window: TimeWindow,
  axis: { min: string; max: string },
  laneHeight: number,
): { top: number; height: number } | null {
  const axisFrom = clockToMinutes(axis.min)
  const axisTo = clockToMinutes(axis.max)
  const from = clockToMinutes(window.from)
  const to = clockToMinutes(window.to)
  if (axisFrom === null || axisTo === null || from === null || to === null) return null
  const span = axisTo - axisFrom
  if (span <= 0 || to <= from) return null
  const px = laneHeight / span
  return { top: (from - axisFrom) * px, height: (to - from) * px }
}

// everyLabel / onlyLabel — подписи областей действия для чипа. Прямоугольник задевает
// несколько дней, и «Каждый вторник» перестаёт быть правдой.
export function everyLabel(dates: string[]): string {
  if (dates.length === 1 && dates[0]) return WEEKDAY_EVERY[weekdayOf(dates[0])]
  return `Каждые ${dates.map((d) => WEEKDAY_SHORT[weekdayOf(d)]).join(', ')}`
}

export function onlyLabel(dates: string[]): string {
  const first = dates[0]
  const last = dates[dates.length - 1]
  if (!first || !last) return ''
  const day = (d: string, withMonth: boolean) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(LOCALE, {
      timeZone: 'UTC',
      day: 'numeric',
      ...(withMonth ? { month: 'long' } : {}),
    })
  if (first === last) return `Только ${day(first, true)}`
  const sameMonth = first.slice(0, 7) === last.slice(0, 7)
  return `Только ${day(first, !sameMonth)} — ${day(last, true)}`
}

// weekStart — понедельник недели, в которую попала дата. Неделя начинается с
// понедельника (WEEKDAYS), и полотно обязано открываться так же.
export function weekStart(date: string): string {
  return shiftDate(date, -WEEKDAYS.indexOf(weekdayOf(date)))
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const at = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000
  return new Date(at).toISOString().slice(0, 10)
}
