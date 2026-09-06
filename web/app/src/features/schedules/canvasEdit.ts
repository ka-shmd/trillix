import {
  MAX_SCHEDULE_EXCEPTIONS,
  type Availability,
  type TimeWindow,
} from '../../entities/schedule'
import { effectiveWindows, weekdayOf } from './canvas'
import { clockToMinutes, minutesToClock, windowsError } from './weekly'

// Жест мышью по полотну → новый документ правила.
//
// ДВУСМЫСЛЕННОСТЬ ЖЕСТА — суть этого файла (ADR §10). Протяжка по колонке вторника
// 16 сентября может значить и «по вторникам принимаю с 10 до 14», и «16-го приму с
// 10 до 14»; угадать нечем, и обе трактовки законны. Поэтому жест применяется с
// ОБЛАСТЬЮ ДЕЙСТВИЯ, а чип рядом с окном её переключает.
//
// Переключение работает так: экран помнит документ ДО жеста и пересчитывает его
// заново другой областью, а не пытается отменить уже применённое. Поэтому чип можно
// щёлкать сколько угодно — состояние не накапливается и не разъезжается.
export type Scope = 'weekly' | 'date'

export type Gesture =
  // Протяжка по пустому месту. ДАТ МОЖЕТ БЫТЬ НЕСКОЛЬКО: протяжка мышью на соседнюю
  // колонку выделяет ПРЯМОУГОЛЬНИК — тот же диапазон часов на каждом задетом дне
  //. Непрерывный отрезок «остаток вторника плюс начало
  // среды» здесь бессмыслен: правило описывает часы приёма, а не одну длинную смену.
  | { kind: 'create'; dates: string[]; window: TimeWindow }
  // Растягивание или перенос внутри дня: orig опознаёт окно на дате.
  | { kind: 'update'; date: string; orig: TimeWindow; window: TimeWindow }
  // Перенос на соседнюю колонку: у жеста две даты, и обе меняются.
  | { kind: 'move'; fromDate: string; orig: TimeWindow; date: string; window: TimeWindow }
  | { kind: 'remove'; date: string; orig: TimeWindow }

// applyGesture — обе области действия одним утверждением: «сделай, чтобы эта колонка
// выглядела вот так — либо каждый вторник, либо только 16-го».
//
// Область `weekly` СНИМАЕТ исключение с этой даты, если оно было: автор смотрит на
// конкретный день и говорит «пусть так будет всегда», а оставленное исключение
// немедленно противоречило бы тому, что он видит.
export function applyGesture(a: Availability, g: Gesture, scope: Scope): Availability {
  // Перенос между колонками — это два жеста подряд по тем же правилам, а не третий
  // способ править документ: окно уходит с одной даты и появляется на другой, и
  // область действия применяется к обеим одинаково.
  if (g.kind === 'move') {
    const without = applyGesture(a, { kind: 'remove', date: g.fromDate, orig: g.orig }, scope)
    return applyGesture(without, { kind: 'create', dates: [g.date], window: g.window }, scope)
  }
  // Прямоугольник — это тот же жест, повторённый по колонкам: каждая дата получает
  // одно и то же окно по общим правилам (слияние, область действия). Отдельной ветки
  // «много дней» в документе нет, и заводить её значило бы держать второй способ
  // править то же самое.
  if (g.kind === 'create') {
    return g.dates.reduce((doc, date) => applyOne(doc, { date, add: g.window }, scope), a)
  }
  if (g.kind === 'remove') {
    return applyOne(a, { date: g.date, remove: g.orig }, scope)
  }
  return applyOne(a, { date: g.date, remove: g.orig, add: g.window }, scope)
}

// applyOne — правка ОДНОГО дня: убрать окно, добавить окно, или и то и другое
// (растягивание — это замена). Слияние соприкоснувшихся обязательно, а не любезность:
// пересекающиеся окна документ запрещает (сервер отвечает 422), а протянуть мышью
// поверх соседнего окна — обычное дело. Автор при этом видит ровно то, что нарисовал:
// два окна, ставшие одним.
function applyOne(
  a: Availability,
  op: { date: string; add?: TimeWindow; remove?: TimeWindow },
  scope: Scope,
): Availability {
  const current = effectiveWindows(a, op.date).windows
  const kept = op.remove ? current.filter((w) => !sameWindow(w, op.remove as TimeWindow)) : current
  const next = mergeWindows(op.add ? [...kept, op.add] : kept)
  if (scope === 'date') {
    const others = a.exceptions.filter((e) => e.date !== op.date)
    return {
      ...a,
      exceptions: [...others, { date: op.date, windows: next }].sort((x, y) =>
        x.date.localeCompare(y.date),
      ),
    }
  }
  return {
    ...a,
    weekly: { ...a.weekly, [weekdayOf(op.date)]: next },
    exceptions: a.exceptions.filter((e) => e.date !== op.date),
  }
}

function sameWindow(a: TimeWindow, b: TimeWindow): boolean {
  return a.from === b.from && a.to === b.to
}

function mergeWindows(windows: TimeWindow[]): TimeWindow[] {
  const spans = windows
    .map((w) => ({ from: clockToMinutes(w.from), to: clockToMinutes(w.to) }))
    .filter(
      (s): s is { from: number; to: number } => s.from !== null && s.to !== null && s.from < s.to,
    )
    .sort((x, y) => x.from - y.from)

  const out: { from: number; to: number }[] = []
  for (const span of spans) {
    const last = out[out.length - 1]
    // `<=`, а не `<`: окна, сомкнувшиеся встык (10:00–12:00 и 12:00–14:00), — это
    // один приём с точки зрения расчёта свободного, и держать их двумя строками
    // значит показывать шов, которого нет.
    if (last && span.from <= last.to) {
      last.to = Math.max(last.to, span.to)
      continue
    }
    out.push({ ...span })
  }
  return out.map((s) => ({ from: minutesToClock(s.from), to: minutesToClock(s.to) }))
}

// docError — почему сервер откажет, человеческими словами. Проверяется ВЕСЬ документ,
// а не тронутый день: исключений и окон конечное число, и упереться в потолок можно
// жестом, который сам по себе безупречен.
export function docError(a: Availability): string | null {
  if (a.exceptions.length > MAX_SCHEDULE_EXCEPTIONS) {
    return `Не больше ${MAX_SCHEDULE_EXCEPTIONS} дней-исключений`
  }
  for (const day of Object.keys(a.weekly)) {
    const err = windowsError(a.weekly[day] ?? [])
    if (err) return err
  }
  for (const ex of a.exceptions) {
    const err = windowsError(ex.windows)
    if (err) return err
  }
  return null
}

// snapMinutes — шаг прилипания жеста, в минутах. Полотно рисует сетку тем же шагом:
// нарисованное мышью окно обязано совпасть с линией, к которой оно прилипло.
export const SNAP_MINUTES = 15

// closeDay — «не принимаю в этот день»: исключение с ПУСТЫМ списком окон. Исключение
// перебивает день целиком (domain, ScheduleException), поэтому пустой список и
// означает закрытый день.
export function closeDay(a: Availability, date: string): Availability {
  const others = a.exceptions.filter((e) => e.date !== date)
  return {
    ...a,
    exceptions: [...others, { date, windows: [] }].sort((x, y) => x.date.localeCompare(y.date)),
  }
}

// resetDay — «принимаю как обычно»: исключение снимается, день возвращается под
// недельное правило.
export function resetDay(a: Availability, date: string): Availability {
  return { ...a, exceptions: a.exceptions.filter((e) => e.date !== date) }
}

// dayState — что сейчас с этим днём: обычная неделя, свои часы или «не принимаю».
// По нему меню колонки решает, показывать ли «принимаю как обычно».
export function dayState(a: Availability, date: string): 'weekly' | 'exception' | 'closed' {
  const ex = a.exceptions.find((e) => e.date === date)
  if (!ex) return 'weekly'
  return ex.windows.length === 0 ? 'closed' : 'exception'
}

// snapToGrid — куда встанет карточка записи, брошенная в эту минуту.
//
// ЗЕРКАЛО СЕРВЕРА, А НЕ ЗАМЕНА ЕМУ: то же правило написано в Go (domain.MoveAligned)
// и решает там (инвариант 3). Здесь оно затем, чтобы промах в семь минут не
// превращался в 422: карточка липнет к ближайшей годной точке, её и называет диалог.
//
// Кандидаты — начала слотов внутри окон приёма и кратные шагу от полуночи вне их.
// Побеждает ближайший, при равном расстоянии — более ранний.
export function snapToGrid(a: Availability, date: string, minutes: number, step: number): number {
  if (step <= 0) return minutes
  const windows = effectiveWindows(a, date)
    .windows.map((w) => ({ from: clockToMinutes(w.from), to: clockToMinutes(w.to) }))
    .filter((w): w is { from: number; to: number } => w.from !== null && w.to !== null)

  const candidates: number[] = []
  for (const w of windows) {
    // Ровно внутри `from…to`: сервер принимает сетку окна только там.
    for (let at = w.from; at < w.to; at += step) {
      if (Math.abs(at - minutes) <= step) candidates.push(at)
    }
  }
  // Вне окон своей сетки нет — там годится кратность шагу от полуночи. Внутри окна
  // такая точка не подходит: у окна сетка своя (domain.MoveAligned).
  for (const c of [Math.floor(minutes / step) * step, Math.ceil(minutes / step) * step]) {
    if (!windows.some((w) => c >= w.from && c < w.to)) candidates.push(c)
  }

  const inDay = candidates.filter((c) => c >= 0 && c < 24 * 60)
  // Годной точки в сутках нет (шаг длиннее суток): отказ придёт от сервера.
  if (inDay.length === 0) return minutes
  return inDay.reduce((best, c) => {
    const closer = Math.abs(c - minutes) < Math.abs(best - minutes)
    const tie = Math.abs(c - minutes) === Math.abs(best - minutes) && c < best
    return closer || tie ? c : best
  })
}
