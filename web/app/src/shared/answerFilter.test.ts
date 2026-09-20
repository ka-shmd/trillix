import { describe, expect, it } from 'vitest'

import {
  decodeFilter,
  emptyScopeHint,
  encodeFilter,
  equalsOp,
  MAX_FILTER_CONDITIONS,
  withCondition,
  type FilterCondition,
} from './answerFilter'

describe('answerFilter', () => {
  // Кириллица в значении: base64url поверх UTF-8, а не поверх строки JS.
  it('упаковывает и распаковывает условия с кириллицей', () => {
    const conds = [
      { blockId: 'plan', op: 'is' as const, value: 'o_pro' },
      { blockId: 'note', op: 'contains' as const, value: 'дорого' },
      { blockId: 'age', op: 'answered' as const },
    ]
    const raw = encodeFilter(conds)
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeFilter(raw)).toEqual(conds)
  })

  // Совместимость с сервером: domain.EncodeAnswerFilter для того же массива даёт ту же
  // строку (base64url без выравнивания).
  it('кодирует так же, как сервер', () => {
    expect(encodeFilter([{ blockId: 'b_src', op: 'is', value: 'o1' }])).toBe(
      'W3siYmxvY2tJZCI6ImJfc3JjIiwib3AiOiJpcyIsInZhbHVlIjoibzEifV0',
    )
  })

  it('пустой список — нет параметра, битый параметр — нет фильтра', () => {
    expect(encodeFilter([])).toBeUndefined()
    expect(decodeFilter('%%%')).toEqual([])
    expect(decodeFilter(undefined)).toEqual([])
  })
})

// Пустая выборка называет то, чем она сужена: сервер отдаёт `unfiltered` и при одном
// сегменте, и текст про «сбросьте фильтр» отсылал бы к пустой панели условий.
describe('emptyScopeHint', () => {
  it('один сегмент — про сегмент, один фильтр — про фильтр, оба — про оба', () => {
    expect(emptyScopeHint(false, true)).toContain('сегмент')
    expect(emptyScopeHint(false, true)).not.toContain('фильтр')
    expect(emptyScopeHint(true, false)).toContain('фильтр')
    expect(emptyScopeHint(true, false)).not.toContain('сегмент')
    expect(emptyScopeHint(true, true)).toContain('фильтр')
    expect(emptyScopeHint(true, true)).toContain('сегмент')
  })
})

// Сложение условий одно на все входы: окно выборки и щелчок по строке
// распределения обязаны вести себя одинаково.
describe('withCondition', () => {
  const city = (v: string): FilterCondition => ({ blockId: 'city', op: 'is', value: v })

  it('условие по другому вопросу добавляется', () => {
    expect(withCondition([city('Москва')], { blockId: 'plan', op: 'is', value: 'pro' })).toEqual([
      city('Москва'),
      { blockId: 'plan', op: 'is', value: 'pro' },
    ])
  })

  // «Город равен Москве И город равен Петербургу» обнуляет выборку: у ответа один
  // город. Второе равенство по тому же вопросу — уточнение, а не второе условие.
  it('второе равенство по тому же вопросу заменяет первое', () => {
    expect(withCondition([city('Москва')], city('Петербург'))).toEqual([city('Петербург')])
  })

  it('то же самое условие снимается', () => {
    expect(withCondition([city('Москва')], city('Москва'))).toEqual([])
  })

  // Диапазон: два РАЗНЫХ оператора по одному вопросу — законная пара.
  it('разные операторы по одному вопросу складываются', () => {
    const gt: FilterCondition = { blockId: 'score', op: 'gt', value: '3' }
    const lt: FilterCondition = { blockId: 'score', op: 'lt', value: '8' }
    expect(withCondition([gt], lt)).toEqual([gt, lt])
  })

  it('сверх потолка условий не добавляет', () => {
    const full = Array.from({ length: MAX_FILTER_CONDITIONS }, (_, i) => ({
      blockId: `b${i}`,
      op: 'answered' as const,
    }))
    expect(withCondition(full, { blockId: 'extra', op: 'answered' })).toEqual(full)
    // Замена при этом работает и на полном списке: она не удлиняет его.
    expect(withCondition(full, { blockId: 'b0', op: 'answered' })).toHaveLength(
      MAX_FILTER_CONDITIONS - 1,
    )
  })
})

// Оператор равенства подставляется там, где его не выбирают: у множественного
// выбора это «в ответе есть вариант», у остальных — «равен».
describe('equalsOp', () => {
  it('множественному выбору — includes, одиночному и шкале — is', () => {
    expect(equalsOp('multi_choice')).toBe('includes')
    expect(equalsOp('single_choice')).toBe('is')
    expect(equalsOp('scale')).toBe('is')
  })
})
