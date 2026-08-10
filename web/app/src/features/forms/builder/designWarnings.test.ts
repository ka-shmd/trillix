import { describe, expect, it } from 'vitest'

import { contrastRatio, lowContrast } from './designWarnings'

describe('contrastRatio', () => {
  it('чёрный на белом — 21:1, предел шкалы', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })

  it('цвет сам с собой — 1:1', () => {
    expect(contrastRatio('#3d3d3d', '#3d3d3d')).toBeCloseTo(1, 5)
  })

  it('порядок аргументов не важен', () => {
    expect(contrastRatio('#111111', '#eeeeee')).toBeCloseTo(
      contrastRatio('#eeeeee', '#111111')!,
      10,
    )
  })

  it('не цвет — null, а не ноль', () => {
    // Ноль читался бы как «контраст ужасный» и давал ложное предупреждение.
    expect(contrastRatio('красный', '#ffffff')).toBeNull()
  })
})

describe('lowContrast', () => {
  it('молчит, когда автор задал не оба цвета', () => {
    // Дефолты темы мы проверили сами; ругаться на собственный вид незачем.
    expect(lowContrast(undefined)).toBeNull()
    expect(lowContrast({ palette: { text: '#777777' } })).toBeNull()
    expect(lowContrast({ palette: { canvas: '#ffffff' } })).toBeNull()
  })

  it('молчит на достаточном контрасте', () => {
    expect(lowContrast({ palette: { text: '#111111', canvas: '#ffffff' } })).toBeNull()
  })

  it('возвращает само отношение, когда оно ниже AA', () => {
    const r = lowContrast({ palette: { text: '#999999', canvas: '#ffffff' } })
    expect(r).not.toBeNull()
    expect(r!).toBeLessThan(4.5)
  })
})
