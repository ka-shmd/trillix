import { COLUMN_WIDTH_TOTAL, MIN_COLUMN_WIDTH } from '@entities/formSchema'

// Арифметика ЖЕСТА ШИРИНЫ (2026-08-22): перетаскивание границы колонок. Вынесено
// чистыми функциями из компонента по тому же доводу, что и правила зон (rowZones.ts):
// перетаскивание мышью в vitest не воспроизводится, и обе формулы молча ломались бы
// правкой соседнего кода.
//
// Устройство самого жеста — ColumnResizer.tsx, модель долей — EDITOR.md §13.

// pxToWidths — ИЗМЕРЕННЫЕ колонки в доли документа: целые, в сумме ровно
// COLUMN_WIDTH_TOTAL. Старт жеста всегда меряется по DOM, а не берётся из документа:
// ряд мог долей и не иметь (тогда колонки равны), а мог иметь их у другого числа
// колонок — экран в обоих случаях говорит правду, документ нет.
//
// Остаток от округления раздаётся по убыванию дробной части (метод наибольших
// остатков): просто «дописать разницу последней колонке» смещало бы её на несколько
// процентов при четырёх колонках, и жест возвращал бы не то, что автор видел.
export function pxToWidths(px: number[]): number[] {
  const span = px.reduce((a, b) => a + b, 0)
  // Ряд нулевой ширины экраном не показан (скрытая вкладка, ещё не смонтирован) —
  // мерить нечего, отдаём равные доли.
  if (span <= 0) return equalWidths(px.length)
  const exact = px.map((w) => (w / span) * COLUMN_WIDTH_TOTAL)
  const out = exact.map((w) => Math.max(1, Math.floor(w)))
  let rest = COLUMN_WIDTH_TOTAL - out.reduce((a, b) => a + b, 0)
  const byFraction = exact
    .map((w, i) => ({ i, frac: w - Math.floor(w) }))
    .sort((a, b) => b.frac - a.frac)
  // Недобор раздаём по одному, перебор (его даёт подъём нулевых колонок до 1) —
  // снимаем с самых широких, чтобы ни одна не ушла ниже единицы.
  for (let k = 0; rest > 0; k++, rest--) out[byFraction[k % out.length]!.i]! += 1
  while (rest < 0) {
    const widest = out.indexOf(Math.max(...out))
    out[widest]! -= 1
    rest++
  }
  return out
}

export function equalWidths(n: number): number[] {
  const base = Math.floor(COLUMN_WIDTH_TOTAL / n)
  const out = Array.from({ length: n }, () => base)
  for (let i = 0; i < COLUMN_WIDTH_TOTAL - base * n; i++) out[i]! += 1
  return out
}

// nextWidths — СДВИГ ГРАНИЦЫ между колонками boundary-1 и boundary на delta долей.
//
// Двигается ровно ПАРА, между которой стоит ручка, а сумма пары сохраняется: остальные
// колонки ряда стоят на месте, и ряд не меняет ширины. Так ведёт себя всякий сплиттер,
// и это единственное правило, при котором автор предсказывает результат при четырёх
// колонках: тянешь границу — двигается она одна.
//
// Колонка не ужимается ниже MIN_COLUMN_WIDTH: при ширине формы 700px это 70px, меньше
// не остаётся места ни под поле, ни под подпись. Упор в предел — не отказ жеста, а
// остановка границы: тянуть дальше можно, ряд просто не меняется.
export function nextWidths(
  widths: number[],
  boundary: number,
  delta: number,
  min = MIN_COLUMN_WIDTH,
): number[] {
  const l = boundary - 1
  const r = boundary
  if (l < 0 || r >= widths.length) return widths
  const pair = widths[l]! + widths[r]!
  // Пара уже теснее двух минимумов (ряд из четырёх колонок, доли заданы не жестом) —
  // двигать нечего: любой сдвиг увёл бы одну из колонок ниже предела.
  if (pair < min * 2) return widths
  const left = Math.min(Math.max(widths[l]! + delta, min), pair - min)
  const out = [...widths]
  out[l] = left
  out[r] = pair - left
  return out
}
