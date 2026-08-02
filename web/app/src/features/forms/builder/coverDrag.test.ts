import { describe, expect, it } from 'vitest'

import { COVER_Y_MAX, COVER_Y_MIN } from '@entities/formSchema'

import { nextCoverY } from './coverDrag'

// Математика жеста «изменить положение». Проверяется отдельно от компонента, потому
// что ошибиться здесь можно ровно в трёх местах — знак, масштаб и края, — и все три
// на глаз выглядят как «перетаскивание работает как-то не так».
describe('nextCoverY', () => {
  const band = 200

  it('увод указателя вверх показывает нижнюю часть картинки (y растёт)', () => {
    expect(nextCoverY(50, 300, 200, band)).toBe(100)
  })

  it('увод вниз показывает верхнюю часть (y падает)', () => {
    expect(nextCoverY(50, 300, 400, band)).toBe(0)
  })

  it('протяжка на высоту полосы проходит весь диапазон', () => {
    expect(nextCoverY(0, 300, 300 - band, band)).toBe(COVER_Y_MAX)
    expect(nextCoverY(COVER_Y_MAX, 300, 300 + band, band)).toBe(COVER_Y_MIN)
  })

  it('за края не выходит', () => {
    expect(nextCoverY(50, 300, -10_000, band)).toBe(COVER_Y_MAX)
    expect(nextCoverY(50, 300, 10_000, band)).toBe(COVER_Y_MIN)
  })

  it('без движения значение не меняется', () => {
    expect(nextCoverY(37, 300, 300, band)).toBe(37)
  })

  it('целое: схема дробный сдвиг не принимает', () => {
    expect(Number.isInteger(nextCoverY(50, 300, 293, 220))).toBe(true)
  })

  // Полосу ещё не смерили (нулевая высота) — деление дало бы Infinity, а Math.round
  // от него NaN: в схему уехало бы значение, которое отвергнет и Zod, и сервер.
  it('нулевая высота полосы не ломает значение', () => {
    expect(nextCoverY(42, 300, 100, 0)).toBe(42)
  })
})
