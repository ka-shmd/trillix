import { type Block, textFromString } from '@entities/formSchema'
import { describe, expect, it } from 'vitest'

import { contrastRatio, coloredSpanCount, darkThemeColorClash, lowContrast } from './designWarnings'

const block = (text: Block['text']): Block =>
  ({ id: 'b1', type: 'text', groupId: 'g1', text, settings: {} }) as Block

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

describe('coloredSpanCount', () => {
  it('считает и цвет текста, и заливку', () => {
    // Обе марки хранят абсолютный #rrggbb и обе за темой не следуют.
    const blocks = [
      block([{ t: 'обычный' }]),
      block([{ t: 'крашеный', color: '#ff0000' }]),
      block([{ t: 'с заливкой', bg: '#ffff00' }]),
    ]
    expect(coloredSpanCount(blocks)).toBe(2)
  })

  it('блок без текста не роняет подсчёт', () => {
    expect(coloredSpanCount([block(undefined)])).toBe(0)
  })

  it('ноль на обычном тексте', () => {
    expect(coloredSpanCount([block(textFromString('просто текст'))])).toBe(0)
  })
})

describe('darkThemeColorClash', () => {
  const painted = [block([{ t: 'крашеный', color: '#ff0000' }])]

  it('на светлой теме молчит — там цвет работает как задумано', () => {
    expect(darkThemeColorClash(undefined, painted)).toBe(0)
    expect(darkThemeColorClash({ theme: 'light' }, painted)).toBe(0)
  })

  it('на тёмной считает крашеные куски', () => {
    expect(darkThemeColorClash({ theme: 'dark' }, painted)).toBe(1)
  })

  it('тёмная тема без крашеного текста не предупреждает', () => {
    expect(darkThemeColorClash({ theme: 'dark' }, [block(textFromString('чистый'))])).toBe(0)
  })
})
