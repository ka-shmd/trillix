import { describe, expect, it } from 'vitest'

import { cssColorToHex, themeColor } from './designDefaults'

// Перевод записи CSS в hex — единственное место, где панель ВЫЧИСЛЯЕТ цвет, а не берёт
// готовый, и ошибка здесь тихая: автор увидит правдоподобный, но не тот оттенок.
// Совпадение литералов с fields.css сторожит check-docs (раздел 8.5) — это проверка
// другой половины: что из сошедшегося литерала выходит верный цвет.
describe('cssColorToHex', () => {
  it('читает rgb()', () => {
    expect(cssColorToHex('rgb(0, 112, 215)')).toBe('#0070d7')
    expect(cssColorToHex('rgb(55, 53, 47)')).toBe('#37352f')
  })

  it('читает oklch()', () => {
    // Крайние точки шкалы: белый обязан выйти ровно белым, иначе матрицы перепутаны.
    expect(cssColorToHex('oklch(1 0 0)')).toBe('#ffffff')
    expect(cssColorToHex('oklch(0 0 0)')).toBe('#000000')
    // Тёплый угольный холст тёмной темы и её текст.
    expect(cssColorToHex('oklch(0.19 0.006 60)')).toBe('#161311')
    expect(cssColorToHex('oklch(0.94 0.004 60)')).toBe('#edeae8')
  })

  it('полупрозрачный цвет сам по себе — null: hex зависит от того, что под ним', () => {
    expect(cssColorToHex('rgb(61 59 53 / 0.16)')).toBeNull()
  })

  it('на незнакомой записи отвечает null, а не подставляет чёрный', () => {
    expect(cssColorToHex('#0070d7')).toBeNull()
    expect(cssColorToHex('color-mix(in srgb, red 50%, blue)')).toBeNull()
    expect(cssColorToHex('')).toBeNull()
  })
})

describe('themeColor', () => {
  it('отдаёт цвет базовой темы для показываемых панелью полей', () => {
    expect(themeColor('light', 'canvas')).toBe('#ffffff')
    expect(themeColor('light', 'field')).toBe('#ffffff')
    expect(themeColor('light', 'text')).toBe('#37352f')
    expect(themeColor('light', 'placeholder')).toBe('#777672')
    expect(themeColor('light', 'accent')).toBe('#0070d7')
    expect(themeColor('light', 'button')).toBe('#0f172b')
    expect(themeColor('light', 'buttonText')).toBe('#f8fafc')
    // Край полупрозрачный (16% чернил) и рисуется тенью — то есть ЗА заливкой поля,
    // на холсте страницы. Поэтому сплющивается по холсту, а не по фону поля.
    expect(themeColor('light', 'border')).toBe('#e0e0df')
    expect(themeColor('dark', 'canvas')).toBe('#161311')
    expect(themeColor('dark', 'field')).toBe('#211f1c')
    expect(themeColor('dark', 'text')).toBe('#edeae8')
    expect(themeColor('dark', 'placeholder')).toBe('#9b9795')
    expect(themeColor('dark', 'accent')).toBe('#3a98ff')
    expect(themeColor('dark', 'button')).toBe('#edeae8')
    expect(themeColor('dark', 'buttonText')).toBe('#161311')
    expect(themeColor('dark', 'border')).toBe('#3b3937')
  })

  it('молчит про цвета, которых в зеркале нет', () => {
    // Панель их не показывает (PALETTE_FIELDS_HIDDEN), поэтому и копии их значений
    // здесь нет: строка палитры на null покажет шашечки, а не выдуманный цвет.
    // Приглушённый — единственный цвет контракта, до которого в панели не добраться.
    expect(themeColor('light', 'muted')).toBeNull()
    expect(themeColor('dark', 'muted')).toBeNull()
  })
})
