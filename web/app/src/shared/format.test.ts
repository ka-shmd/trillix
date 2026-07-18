import { describe, expect, it } from 'vitest'

import { conversionPercent, pluralViews } from './format'

describe('pluralViews', () => {
  it('склоняет по последней цифре', () => {
    expect(pluralViews(1)).toBe('просмотр')
    expect(pluralViews(2)).toBe('просмотра')
    expect(pluralViews(5)).toBe('просмотров')
    expect(pluralViews(21)).toBe('просмотр')
    expect(pluralViews(102)).toBe('просмотра')
  })

  // Числа 11–14 — исключение из правила последней цифры (не «11 просмотр»).
  it('не спотыкается на 11–14', () => {
    expect(pluralViews(11)).toBe('просмотров')
    expect(pluralViews(12)).toBe('просмотров')
    expect(pluralViews(14)).toBe('просмотров')
    expect(pluralViews(111)).toBe('просмотров')
  })

  it('ноль — множественное', () => {
    expect(pluralViews(0)).toBe('просмотров')
  })
})

describe('conversionPercent', () => {
  it('считает долю отправивших от открывших', () => {
    expect(conversionPercent(1, 4)).toBe(25)
    expect(conversionPercent(12, 187)).toBe(6)
    expect(conversionPercent(3, 3)).toBe(100)
  })

  // Ноль просмотров ≠ нулевая конверсия: «никто не открывал» и «открывали, но никто
  // не отправил» — разные новости, поэтому null, а не 0.
  it('без просмотров возвращает null, а не ноль процентов', () => {
    expect(conversionPercent(0, 0)).toBeNull()
  })

  it('открывали, но не отправляли — честный ноль', () => {
    expect(conversionPercent(0, 20)).toBe(0)
  })
})
