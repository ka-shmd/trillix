import { describe, expect, it } from 'vitest'

import { formInk, formTint, formTone } from './formColor'

// ЦВЕТ ЗАКРЕПЛЁН ЗА ФОРМОЙ, А НЕ ЗА МЕСТОМ В СПИСКЕ. Место меняется от каждой новой
// записи; цвет, привязанный к нему, менял бы значение на глазах у автора — и подсказка
// «чья это запись» превратилась бы в шум.

describe('цвет формы', () => {
  it('один и тот же id всегда даёт один тон', () => {
    expect(formTone('form-alpha')).toBe(formTone('form-alpha'))
    expect(formInk('form-alpha')).toBe(formInk('form-alpha'))
  })

  it('тон всегда из набора дизайн-системы', () => {
    const ids = ['a', 'b', '01a06b9b-1234-4321-8888-000000000001', '', 'ф', 'x'.repeat(200)]
    for (const id of ids) {
      const tone = formTone(id)
      expect(tone).toBeGreaterThanOrEqual(1)
      expect(tone).toBeLessThanOrEqual(8)
      expect(formInk(id)).toBe(`var(--chart-${tone})`)
      expect(formTint(id)).toContain(`var(--chart-${tone})`)
    }
  })

  it('разные формы разводятся по тонам', () => {
    const ids = ['form-alpha', 'form-beta', 'form-gamma', 'form-delta']
    expect(new Set(ids.map(formTone)).size).toBeGreaterThan(1)
  })
})
