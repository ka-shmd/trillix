import { describe, expect, it } from 'vitest'

import { conversionPercent, formatDuration, formatRelative, pluralViews } from './format'

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

describe('относительное время', () => {
  const now = new Date('2026-08-24T12:00:00Z')

  it('минуты и часы читаются словами', () => {
    // Через Intl, а не своим склонением: правила множественного числа уже написаны
    // в браузере, и вторая их копия разошлась бы на «2 минуты» против «5 минут».
    expect(formatRelative('2026-08-24T11:58:00Z', now)).toContain('2')
    expect(formatRelative('2026-08-24T09:00:00Z', now)).toContain('3')
  })

  it('давнее показывается датой, а не «60 дней назад»', () => {
    expect(formatRelative('2026-01-05T10:00:00Z', now)).toMatch(/2026/)
  })

  it('мусор вместо даты не роняет строку', () => {
    expect(formatRelative('не дата', now)).toBe('—')
  })
})

describe('длительность', () => {
  it('секунды, минуты и часы', () => {
    expect(formatDuration(8)).toBe('8 с')
    expect(formatDuration(125)).toBe('2 мин 5 с')
    expect(formatDuration(3840)).toBe('1 ч 4 мин')
  })

  it('дробные секунды округляются', () => {
    // Точность медианы визитов дробей не заслуживает.
    expect(formatDuration(8.6)).toBe('9 с')
  })
})
