import { designSchema } from '@entities/formSchema'
import { describe, expect, it } from 'vitest'

import { currentTheme, hasCustomFields, resetToTheme, withTheme } from './designTheme'

describe('hasCustomFields', () => {
  it('тема сама по себе своей настройкой не считается', () => {
    // Иначе выбор тёмной сразу переключал бы дропдаун на «Пользовательскую», и
    // готовую тему нельзя было бы выбрать вообще.
    expect(hasCustomFields(undefined)).toBe(false)
    expect(hasCustomFields({})).toBe(false)
    expect(hasCustomFields({ theme: 'dark' })).toBe(false)
  })

  it.each([
    ['цвет', { palette: { accent: '#00aa55' } }],
    ['шрифт', { font: 'inter' }],
    ['лэйаут', { layout: { fontSize: 18 } }],
    ['поля', { controls: { radius: 0 } }],
    ['кнопка', { button: { size: 'lg' } }],
  ] as const)('любая своя настройка считается: %s', (_name, design) => {
    expect(hasCustomFields(design)).toBe(true)
  })
})

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

  it('своя настройка САМА делает тему пользовательской', () => {
    // Ровно то, чего просил владелец, и без единой строки «поставить
    // пользовательскую»: она выводится из документа, а не хранится в нём.
    expect(currentTheme({ palette: { accent: '#00aa55' } })).toBe('custom')
  })

  it('пользовательская сильнее базы', () => {
    // Тёмная база со своим акцентом — это уже не «Тёмная»: показывать её так значило
    // бы врать про форму, которая от готовой темы отличается.
    expect(currentTheme({ theme: 'dark', palette: { accent: '#00aa55' } })).toBe('custom')
  })
})

describe('resetToTheme', () => {
  it('светлая — пустой документ, а не theme: light', () => {
    // Форма, у которой тему включили и выключили, обязана стать байт в байт прежней.
    expect(resetToTheme('light')).toBeUndefined()
  })

  it('тёмная — только ключ темы', () => {
    expect(resetToTheme('dark')).toEqual({ theme: 'dark' })
  })

  it('СБРАСЫВАЕТ все свои настройки — ради этого панель и спрашивает', () => {
    // Функция не принимает прежний документ вовсе: «вернуться к готовой теме» и
    // означает «моих настроек больше нет». Приняв его, легко было бы однажды
    // случайно что-то сохранить и получить тему, которая не равна себе же.
    expect(resetToTheme('dark')).toEqual({ theme: 'dark' })
    expect(currentTheme(resetToTheme('dark'))).toBe('dark')
    expect(currentTheme(resetToTheme('light'))).toBe('light')
  })

  it('результат остаётся валидным документом оформления', () => {
    expect(designSchema.safeParse(resetToTheme('dark')).success).toBe(true)
  })
})

describe('withTheme', () => {
  it('меняет базу, не трогая остальное', () => {
    // Нужна там, где сбрасывать нечего; сброс — дело resetToTheme.
    const design = { palette: { accent: '#00aa55' } } as const
    expect(withTheme(design, 'dark')).toEqual({ ...design, theme: 'dark' })
  })

  it('включили и выключили — документ вернулся к исходному', () => {
    expect(withTheme(withTheme(undefined, 'dark'), 'light')).toBeUndefined()
  })
})
