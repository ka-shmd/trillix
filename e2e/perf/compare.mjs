#!/usr/bin/env node
// Разница двух прогонов замера: `node perf/compare.mjs baseline after-step-a`.
//
// Существует ровно затем, чтобы отчёт содержал ПАРУ, а не одно число: замер только
// «после» одинаково выглядит и когда фикс работает, и когда он не применился
// (PROCESS §4).
import { readFileSync } from 'node:fs'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('использование: node perf/compare.mjs <метка-до> <метка-после>')
  process.exit(2)
}

const load = (label) =>
  JSON.parse(readFileSync(new URL(`./results/${label}.json`, import.meta.url), 'utf8'))

const before = load(a)
const after = load(b)

const num = (v) => (typeof v === 'number' ? v : null)
const fmt = (v, digits = 1) => (v === null ? 'н/д' : v.toFixed(digits))

// Отношение печатается только когда обе стороны — числа: «н/д → 5» не улучшение и не
// ухудшение, а несработавшая диагностика.
function delta(x, y, digits = 1, unit = '') {
  const p = num(x)
  const q = num(y)
  if (p === null || q === null) return `${fmt(p, digits)} → ${fmt(q, digits)}${unit}`
  const times = p === 0 ? null : p / q
  const tail = times === null ? '' : `  (×${times.toFixed(1)})`
  return `${fmt(p, digits)} → ${fmt(q, digits)}${unit}${tail}`
}

console.log(`${a} → ${b}\n`)
for (const [i, row] of before.report.entries()) {
  const next = after.report[i]
  if (!next || next.blocks !== row.blocks) {
    console.log(`!! прогоны сняты на разных размерах форм — сравнивать нельзя`)
    process.exit(1)
  }
  console.log(`=== ${row.blocks} блоков ===`)
  console.log(`  набор, мс/символ:      ${delta(row.typing.perChar.scriptMs, next.typing.perChar.scriptMs)}`)
  console.log(`  набор, КБ/символ:      ${delta(row.typing.perChar.heapKb, next.typing.perChar.heapKb, 0)}`)
  console.log(`  набор, мутаций/символ: ${delta(row.typing.perChar.mutations, next.typing.perChar.mutations, 0)}`)
  console.log(`  Enter, rect'ов:        ${delta(row.structural.boundingRects, next.structural.boundingRects, 0)}`)
  console.log(`  драг, мс JS:           ${delta(row.drag.scriptMs, next.drag.scriptMs, 0)}`)
  console.log(`  драг, МБ:              ${delta(row.drag.heapDeltaMb, next.drag.heapDeltaMb)}`)
  console.log(`  драг, ResizeObserver:  ${delta(row.drag.resizeObservers, next.drag.resizeObservers, 0)}`)
  console.log(`  драг, худший кадр мс:  ${delta(row.drag.worstFrameMs, next.drag.worstFrameMs, 0)}`)
  console.log(`  драг, p95 кадра мс:    ${delta(row.drag.p95FrameMs, next.drag.p95FrameMs, 0)}`)
  console.log(`  удержано после GC, МБ: ${fmt(row.drag.retainedMbAfterGc, 2)} → ${fmt(next.drag.retainedMbAfterGc, 2)}`)
  console.log('')
}
