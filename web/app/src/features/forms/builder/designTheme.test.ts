import { designSchema } from '@entities/formSchema'
import { describe, expect, it } from 'vitest'

import { currentTheme, withTheme } from './designTheme'

describe('currentTheme', () => {
  it('отсутствие оформления и светлая тема показываются одинаково', () => {
    // Иначе форма, которой оформления не касались, выглядела бы в дропдауне
    // «ничем не выбранной».
    expect(currentTheme(undefined)).toBe('light')
    expect(currentTheme({})).toBe('light')
    expect(currentTheme({ theme: 'light' })).toBe('light')
  })

  it('тёмная показывается тёмной', () => {
    expect(currentTheme({ theme: 'dark' })).toBe('dark')
  })
})

describe('withTheme', () => {
  it('тёмная ставит ключ', () => {
    expect(withTheme(undefined, 'dark')).toEqual({ theme: 'dark' })
  })

  it('светлая СНИМАЕТ ключ, а не пишет theme: light', () => {
    // Главное свойство фазы: форма, у которой тему включили и выключили, обязана
    // стать байт в байт прежней. theme: 'light' дал бы документ, отличающийся от
    // исходного при одинаковом виде, — расхождение, которое живёт вечно.
    expect(withTheme({ theme: 'dark' }, 'light')).toBeUndefined()
  })

  it('включили и выключили — документ вернулся к исходному', () => {
    const started = undefined
    expect(withTheme(withTheme(started, 'dark'), 'light')).toEqual(started)
  })

  it('не трогает остальное оформление', () => {
    const design = { palette: { accent: '#00aa55' }, controls: { radius: 12 } } as const
    expect(withTheme(design, 'dark')).toEqual({ ...design, theme: 'dark' })
    expect(withTheme({ ...design, theme: 'dark' }, 'light')).toEqual(design)
  })

  it('пустой остаток схлопывается в undefined, а не в {}', () => {
    // design: {} валиден, но это ключ в JSONB, которого автор не просил.
    expect(withTheme({ theme: 'dark' }, 'light')).toBeUndefined()
  })

  it('результат остаётся валидным документом оформления', () => {
    const next = withTheme({ palette: { accent: '#00aa55' } }, 'dark')
    expect(designSchema.safeParse(next).success).toBe(true)
  })
})
