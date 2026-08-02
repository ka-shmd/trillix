import { describe, expect, it } from 'vitest'

import { type ClientRect } from '@dnd-kit/core'
import { verticalListSortingStrategy } from '@dnd-kit/sortable'

import { canvasSorting } from './dnd'

// Стратегия расступания строк (2026-08-02). Проверяется РЕЗУЛЬТАТ, а не формула: пока
// элемент тащат, две строки не имеют права оказаться в одном месте. Это ровно то, что
// владелец увидел на полотне глазами («вытаскиваем блок из ряда — блоки под рядом
// наезжают на ряд»), и ровно то, чего родная verticalListSortingStrategy не даёт:
// каждый тест ниже предъявляет её падение на тех же данных.
//
// Числа — как в живом DOM: строка меряется border-box'ом (BlockRow добавляет py-1.5 и
// гасит его -my-1.5), поэтому просвет 14px ритма даёт 2px между прямоугольниками, а
// 28px — 16px. Полоса полотна — 700px, колонка секции — 336px при 28px-жёлобе.

const CANVAS = 700
const COL = 336
const GUTTER = 28

const rect = (top: number, height: number, left = 0, width = CANVAS): ClientRect => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
})

// Столбик из [высота, просвет, высота, просвет, …].
function column(spec: number[], left = 0, width = CANVAS, from = 0): ClientRect[] {
  const out: ClientRect[] = []
  let y = from
  for (let i = 0; i < spec.length; i += 2) {
    out.push(rect(y, spec[i]!, left, width))
    y += spec[i]! + (spec[i + 1] ?? 0)
  }
  return out
}

type Placed = { index: number; top: number; bottom: number; left: number; width: number }

// Куда строки приедут: применяем стратегию ко ВСЕМ индексам и складываем сдвиг с
// исходным прямоугольником. Активный исключён — под указателем он едет за курсором и в
// чужую геометрию не вписывается.
function settle(
  strategy: typeof canvasSorting,
  rects: ClientRect[],
  activeIndex: number,
  overIndex: number,
): Placed[] {
  return rects
    .map((r, index) => {
      const t = strategy({
        rects,
        activeIndex,
        overIndex,
        index,
        activeNodeRect: rects[activeIndex]!,
      })
      return {
        index,
        top: r.top + (t?.y ?? 0),
        bottom: r.top + r.height + (t?.y ?? 0),
        left: r.left,
        width: r.width,
      }
    })
    .filter((r) => r.index !== activeIndex)
}

// Наложение — пара строк, которые пересеклись И по вертикали, и по горизонтали.
// Соседство по РЯДУ (одна вертикаль, разные колонки) наложением не является: так стоят
// участники секции.
function overlaps(placed: Placed[]): string[] {
  const bad: string[] = []
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!
      const b = placed[j]!
      const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      const h = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
      if (v > 0 && h > 0) bad.push(`${a.index}↔${b.index}`)
    }
  }
  return bad
}

// Полотно с СЕКЦИЕЙ наверху: ряд из двух колонок, под ним обычные полноширинные строки.
// Порядок в документе колоночный (§13): сперва вся левая колонка, потом вся правая.
//   0 — левая колонка ряда (40px)
//   1 — правая колонка ряда (76px, ряд держит она)
//   2,3 — строки под рядом
function sectionCanvas(): ClientRect[] {
  const rowTop = 0
  const rowBottom = 76
  return [
    rect(rowTop, 40, 0, COL),
    rect(rowTop, 76, COL + GUTTER, COL),
    ...column([36, 2, 36], 0, CANVAS, rowBottom + 16),
  ]
}

describe('canvasSorting', () => {
  it('блок, вынутый из колонки ряда, не подтягивает строки под рядом', () => {
    const rects = sectionCanvas()
    // Тащим левую колонку ряда вниз, мимо строк под ним.
    const placed = settle(canvasSorting, rects, 0, 3)
    expect(overlaps(placed)).toEqual([])
    // Ряд держит правая колонка — отдавать нечего, и нижние строки стоят на месте.
    for (const p of placed) expect(p.top).toBe(rects[p.index]!.top)
  })

  it('родная стратегия на тех же данных сажает строки на ряд', () => {
    const placed = settle(verticalListSortingStrategy, sectionCanvas(), 0, 3)
    expect(overlaps(placed).length).toBeGreaterThan(0)
  })

  it('если уходящий был в ряду самым низким — отдаётся ровно разница низов', () => {
    // Зеркало предыдущего: теперь ряд держит ЛЕВАЯ колонка (76px), уходит правая (40px),
    // а ниже неё в документе строки. Вынимая её, ряд не меняется вовсе.
    const rects = [
      rect(0, 76, 0, COL),
      rect(0, 40, COL + GUTTER, COL),
      ...column([36, 2, 36], 0, CANVAS, 92),
    ]
    expect(settle(canvasSorting, rects, 1, 3).every((p) => p.top === rects[p.index]!.top)).toBe(true)

    // А теперь уходит тот, кто ряд и держал: освобождается 76 − 40 = 36.
    const tallLeaves = settle(canvasSorting, rects, 0, 3)
    expect(overlaps(tallLeaves)).toEqual([])
    expect(tallLeaves.find((p) => p.index === 2)!.top).toBe(rects[2]!.top - 36)
  })

  it('строки чужой колонки не двигаются вовсе', () => {
    const rects = sectionCanvas()
    const t = canvasSorting({
      rects,
      activeIndex: 0,
      overIndex: 3,
      index: 1,
      activeNodeRect: rects[0]!,
    })
    expect(t).toBeNull()
  })

  describe('обычный полноширинный столбик', () => {
    // Ритм полотна: 14px внутри вопроса и 28px между вопросами → 2px и 16px по
    // border-box'ам.
    const canvas = column([40, 2, 36, 16, 40, 2, 36, 16, 36])

    it('перенос вниз: смещаемые едут все на одно расстояние и не накладываются', () => {
      const placed = settle(canvasSorting, canvas, 0, 3)
      expect(overlaps(placed)).toEqual([])
      const moved = placed.filter((p) => p.index >= 1 && p.index <= 3)
      const shifts = new Set(moved.map((p) => p.top - canvas[p.index]!.top))
      expect(shifts.size).toBe(1)
      // Освобождается высота уходящего плюс его собственный просвет: 40 + 2.
      expect([...shifts][0]).toBe(-42)
    })

    it('перенос вверх: то же зеркально', () => {
      const placed = settle(canvasSorting, canvas, 4, 1)
      expect(overlaps(placed)).toEqual([])
      const moved = placed.filter((p) => p.index >= 1 && p.index <= 3)
      const shifts = new Set(moved.map((p) => p.top - canvas[p.index]!.top))
      expect(shifts.size).toBe(1)
      // Уходящий (36) отдаёт свою высоту и просвет НАД собой (16).
      expect([...shifts][0]).toBe(52)
    })

    it('ритм не перетасовывается: просветы между смещаемыми те же, что были', () => {
      const placed = settle(canvasSorting, canvas, 0, 3).filter((p) => p.index <= 3)
      const gaps = placed.slice(1).map((p, i) => p.top - placed[i]!.bottom)
      expect(gaps).toEqual([16, 2])
      // Родная стратегия на тех же данных просветы сдвигает по кругу.
      const native = settle(verticalListSortingStrategy, canvas, 0, 3).filter((p) => p.index <= 3)
      expect(native.slice(1).map((p, i) => p.top - native[i]!.bottom)).not.toEqual([16, 2])
    })
  })

  it('молчит, когда двигать некого', () => {
    const one = column([36])
    expect(
      canvasSorting({ rects: one, activeIndex: 0, overIndex: 0, index: 0, activeNodeRect: one[0]! }),
    ).toBeNull()
  })
})
