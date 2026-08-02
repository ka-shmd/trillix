// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { CoverBand, LogoMark } from '@fields/pageChrome'

// Нативный drag картинки перебивает жест «изменить положение»: браузер начинает своё
// перетаскивание через несколько пикселей, снимает захват указателя и шлёт
// pointercancel — сдвиг обрывается почти сразу, а за курсором едет призрак картинки.
// Найдено владельцем на живой проверке 2026-08-02. Сторож здесь потому, что чинится
// это одним атрибутом, который легко потерять при любой правке разметки, а красного
// без него не будет нигде: жест «работает, только плохо».

afterEach(cleanup)

describe('хром страницы не перетаскивается нативно', () => {
  it('картинка обложки не draggable', () => {
    const { container } = render(<CoverBand cover={{ imageKey: 'ws/a.jpg' }} />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('draggable')).toBe('false')
  })

  it('логотип не draggable', () => {
    const { container } = render(<LogoMark logo={{ imageKey: 'ws/logo.png' }} />)
    expect(container.querySelector('img')?.getAttribute('draggable')).toBe('false')
  })

  // Заодно фиксируем, что цветная обложка картинки не заводит вовсе: тащить нечего,
  // и жест сдвига для неё не предлагается.
  it('цветная обложка рисуется без картинки', () => {
    const { container } = render(<CoverBand cover={{ color: '#ff8800' }} />)
    expect(container.querySelector('img')).toBeNull()
  })
})
