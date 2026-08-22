import { describe, expect, it } from 'vitest'

import { COLUMN_WIDTH_TOTAL, MIN_COLUMN_WIDTH } from '@entities/formSchema'
import { equalWidths, nextWidths, pxToWidths } from './columnResize'

// Арифметика жеста ширины. Перетаскивание мышью в vitest не воспроизводится, поэтому
// формулы вынесены из компонента и проверяются здесь — тот же приём и тот же довод,
// что у правил зон (rowZones.test.ts).

const sums = (w: number[]) => w.reduce((a, b) => a + b, 0)

describe('pxToWidths', () => {
  it('половины дают 50/50', () => {
    expect(pxToWidths([300, 300])).toEqual([50, 50])
  })

  it('сумма ровно 100 при неделимых пропорциях', () => {
    const w = pxToWidths([200, 200, 200])
    expect(sums(w)).toBe(COLUMN_WIDTH_TOTAL)
    expect(w).toEqual([34, 33, 33])
  })

  it('остаток раздаётся по убыванию дробной части, а не последней колонке', () => {
    // 145/700, 245/700, 310/700 = 20.71 / 35 / 44.28 — единицу забирает первая.
    expect(pxToWidths([145, 245, 310])).toEqual([21, 35, 44])
  })

  it('колонка не получает ноль, даже если её почти не видно', () => {
    const w = pxToWidths([699, 1])
    expect(w).toEqual([99, 1])
    expect(sums(w)).toBe(COLUMN_WIDTH_TOTAL)
  })

  it('неизмеренный ряд (нулевая ширина) — равные доли', () => {
    expect(pxToWidths([0, 0, 0])).toEqual(equalWidths(3))
  })
})

describe('nextWidths', () => {
  it('двигает ПАРУ у границы, сумма пары сохраняется', () => {
    expect(nextWidths([50, 50], 1, 20)).toEqual([70, 30])
  })

  it('остальные колонки ряда стоят', () => {
    expect(nextWidths([25, 25, 50], 1, 10)).toEqual([35, 15, 50])
    expect(nextWidths([25, 25, 50], 2, -10)).toEqual([25, 15, 60])
  })

  it('колонка не ужимается ниже предела — граница упирается, ряд цел', () => {
    const w = nextWidths([50, 50], 1, 95)
    expect(w).toEqual([COLUMN_WIDTH_TOTAL - MIN_COLUMN_WIDTH, MIN_COLUMN_WIDTH])
    expect(sums(w)).toBe(COLUMN_WIDTH_TOTAL)
  })

  it('упор в предел с другой стороны', () => {
    expect(nextWidths([50, 50], 1, -95)).toEqual([MIN_COLUMN_WIDTH, COLUMN_WIDTH_TOTAL - MIN_COLUMN_WIDTH])
  })

  it('пара теснее двух минимумов — жест ничего не двигает', () => {
    const cramped = [8, 8, 84]
    expect(nextWidths(cramped, 1, 5)).toBe(cramped)
  })

  it('границы вне ряда не существует', () => {
    const w = [50, 50]
    expect(nextWidths(w, 0, 10)).toBe(w)
    expect(nextWidths(w, 2, 10)).toBe(w)
  })

  it('сумма ряда не меняется ни при каком сдвиге', () => {
    for (const delta of [-40, -7, 0, 3, 60]) {
      expect(sums(nextWidths([25, 25, 25, 25], 2, delta))).toBe(COLUMN_WIDTH_TOTAL)
    }
  })
})
