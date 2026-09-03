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
  // Протяжка по пустому месту.
  | { kind: 'create'; date: string; window: TimeWindow }
  // Перенос или растягивание существующего окна: orig опознаёт его на дате.
  | { kind: 'update'; date: string; orig: TimeWindow; window: TimeWindow }
  | { kind: 'remove'; date: string; orig: TimeWindow }

// applyGesture — обе области действия одним утверждением: «сделай, чтобы эта колонка
// выглядела вот так — либо каждый вторник, либо только 16-го».
//
// Область `weekly` СНИМАЕТ исключение с этой даты, если оно было: автор смотрит на
// конкретный день и говорит «пусть так будет всегда», а оставленное исключение
// немедленно противоречило бы тому, что он видит.
export function applyGesture(a: Availability, g: Gesture, scope: Scope): Availability {
  const next = nextWindows(effectiveWindows(a, g.date).windows, g)
  if (scope === 'date') {
    const others = a.exceptions.filter((e) => e.date !== g.date)
    return {
      ...a,
      exceptions: [...others, { date: g.date, windows: next }].sort((x, y) =>
        x.date.localeCompare(y.date),
      ),
    }
  }
  return {
    ...a,
    weekly: { ...a.weekly, [weekdayOf(g.date)]: next },
    exceptions: a.exceptions.filter((e) => e.date !== g.date),
  }
}

// nextWindows — окна дня после жеста: сортировка и слияние соприкоснувшихся.
//
// Слияние обязательно, а не любезность: пересекающиеся окна документ запрещает
// (сервер отвечает 422), а протянуть мышью поверх соседнего окна — обычное дело.
// Автор при этом видит ровно то, что нарисовал: два окна, ставшие одним.
function nextWindows(windows: TimeWindow[], g: Gesture): TimeWindow[] {
  const kept = g.kind === 'create' ? windows : windows.filter((w) => !sameWindow(w, g.orig))
  const added = g.kind === 'remove' ? [] : [g.window]
  return mergeWindows([...kept, ...added])
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
