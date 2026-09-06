import { type FreeSlot } from '../booking'
import { LOCALE } from '../locale'

// Чистая часть пикера: как список свободных точек превращается в то, что видит
// респондент. Отдельно от компонента, потому что проверяется таблицей, а не глазами.

// SlotDay — один день выдачи: ключ (местная дата) и времена этого дня.
export type SlotDay = {
  key: string
  slots: FreeSlot[]
}

// DayCell — квадрат в ленте дат: число, день недели и времена. Пустой slots значит
// «день показан, но записаться в него нельзя» — лента идёт КАЛЕНДАРНО, подряд.
export type DayCell = {
  key: string
  // date — местная полночь этого дня. Нужна подписи месяца над лентой и заголовку
  // над сеткой времён: обе считают склонения и год сами, из готовой даты.
  date: Date
  num: string
  weekday: string
  slots: FreeSlot[]
}

// groupByDay режет плоский список точек по МЕСТНЫМ суткам респондента.
//
// Сутки считаются в поясе того, кто смотрит, а не расписания: человек выбирает время
// своим календарём, и «четверг» для него — его четверг. Расписание при этом может быть
// в другом поясе — тогда одна и та же точка попадёт у автора и у респондента в разные
// дни, и это правильно.
export function groupByDay(slots: FreeSlot[]): SlotDay[] {
  const days: SlotDay[] = []
  const index = new Map<string, SlotDay>()
  for (const slot of slots) {
    const at = new Date(slot.startsAt)
    if (Number.isNaN(at.getTime())) continue
    const key = dayKey(at)
    let day = index.get(key)
    if (!day) {
      day = { key, slots: [] }
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

// STRIP_CAP — потолок длины ленты. Горизонт расписания не больше 365 дней (CHECK
// миграции 0050), так что до потолка дело не доходит; он стоит на пути цикла по датам,
// который при испорченной дате конца крутился бы до конца вкладки.
const STRIP_CAP = 400

// dayStrip разворачивает дни с временами в НЕПРЕРЫВНУЮ ленту календарных дат: от
// первого свободного дня до последнего, включая те, где записаться не на что.
//
// Дыры показываются, а не выбрасываются: строка «10, 11, 14, 17» читается как ошибка
// выдачи, а погашенный квадрат — как «в среду он не принимает». Начало ленты — первый
// свободный день, а не сегодня: пустая первая страница у расписания, открытого через
// месяц, — это лишний ход шевроном на ровном месте.
export function dayStrip(days: SlotDay[]): DayCell[] {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const bySlots = new Map(days.map((d) => [d.key, d.slots]))
  const cells: DayCell[] = []
  const at = fromKey(first.key)
  const end = fromKey(last.key)
  if (!at || !end) return []
  while (at.getTime() <= end.getTime() && cells.length < STRIP_CAP) {
    const key = dayKey(at)
    cells.push({
      key,
      date: new Date(at),
      num: at.toLocaleDateString(LOCALE, { day: 'numeric' }),
      weekday: at.toLocaleDateString(LOCALE, { weekday: 'short' }),
      slots: bySlots.get(key) ?? [],
    })
    // Шаг сеттером, а не прибавкой суток в миллисекундах: в день перевода часов сутки
    // не 24 часа, и арифметика на числах пропустила бы день или удвоила его.
    at.setDate(at.getDate() + 1)
  }
  return cells
}

// monthLabel — подпись над лентой. Окно из семи дней запросто лежит в двух месяцах, и
// тогда называются оба: «сентябрь — октябрь 2026».
//
// Год пишется словами, а не через toLocaleDateString({ month, year }): русская локаль
// добавляет туда «г.», и подпись превращается в строку из документа.
export function monthLabel(cells: DayCell[]): string {
  const first = cells[0]
  const last = cells[cells.length - 1]
  if (!first || !last) return ''
  const month = (at: Date) => at.toLocaleDateString(LOCALE, { month: 'long' })
  const year = (at: Date) => String(at.getFullYear())
  if (first.date.getFullYear() !== last.date.getFullYear()) {
    return `${month(first.date)} ${year(first.date)} — ${month(last.date)} ${year(last.date)}`
  }
  if (first.date.getMonth() !== last.date.getMonth()) {
    return `${month(first.date)} — ${month(last.date)} ${year(last.date)}`
  }
  return `${month(first.date)} ${year(first.date)}`
}

// СКОЛЬКО КВАДРАТОВ ВЛЕЗАЕТ. Лента занимает всю ширину блока, поэтому число дней в ней
// считается от ширины, а не прибито семёркой: на колонке в 700px семь квадратов раздулись
// бы до 90px каждый.
//
// ⚠ GAP обязан совпадать с зазором .rf-slots-week в slots.css: разойдясь, счёт даст на
// день больше, чем помещается, и последний квадрат поедет узким.
const CELL = 52
const GAP = 6
const COLS_MIN = 7
const COLS_MAX = 14

// colsFor — сколько квадратов положить в страницу ленты при такой ширине. Потолок и пол
// не дают ленте выродиться: на телефоне остаётся неделя (квадраты ужимаются, но неделя
// видна целиком), на очень широкой колонке — две.
export function colsFor(width: number): number {
  if (!(width > 0)) return COLS_MIN
  const fit = Math.floor((width + GAP) / (CELL + GAP))
  return Math.max(COLS_MIN, Math.min(COLS_MAX, fit))
}

// fullDayLabel — заголовок над сеткой времён: «четверг, 10 сентября». Полное имя дня, а
// не сокращение из квадрата: под сеткой оно читается как ответ на «какой день выбран».
export function fullDayLabel(cell: DayCell): string {
  return cell.date.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })
}

// dayKey — местная дата «ГГГГ-ММ-ДД». Своя сборка, а не toISOString: тот отдаёт UTC, и
// вечерние слоты уехали бы в следующий день у всех, кто восточнее Гринвича. Наружу —
// ради заглушки вида (SlotStub): она строит ленту из тех же ключей.
export function dayKey(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

// fromKey — местная полночь по ключу дня. Через конструктор с тремя числами, а не
// new Date('2026-09-10'): строку-дату браузер читает как UTC-полночь.
function fromKey(key: string): Date | null {
  const [y, m, d] = key.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) return null
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null
  return new Date(y, m - 1, d)
}

// timeLabel — время точки в поясе читателя.
export function timeLabel(startsAt: string): string {
  return new Date(startsAt).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
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
