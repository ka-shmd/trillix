import { describe, expect, it } from 'vitest'

import { decodeFilter, emptyScopeHint, encodeFilter } from './answerFilter'

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
