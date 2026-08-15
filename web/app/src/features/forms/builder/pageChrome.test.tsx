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

// РАЗМЕРЫ ХРОМА печатаются переменными на самом элементе, а незаданные не печатаются
// вовсе — дефолт живёт в :root fields.css. Второе важнее первого: форма, у которой
// размеры не трогали, обязана рисоваться теми же правилами, что и до этой настройки,
// а не своей копией тех же чисел в атрибуте style.
describe('размеры хрома уезжают переменными', () => {
  it('логотип печатает стороны и скругление', () => {
    const { container } = render(
      <LogoMark logo={{ imageKey: 'ws/logo.png', width: 140, height: 80, radius: 12 }} />,
    )
    const style = container.querySelector('.rf-logo')?.getAttribute('style') ?? ''
    expect(style).toContain('--rf-logo-w: 140px')
    expect(style).toContain('--rf-logo-h: 80px')
    expect(style).toContain('--rf-logo-radius: 12px')
  })

  // Высота обложки — доля ОКНА (vh), а не пиксели: автор задаёт долю экрана.
  it('обложка печатает высоту в vh — и у цвета тоже', () => {
    const { container } = render(<CoverBand cover={{ color: '#ff8800', height: 40 }} />)
    const style = container.querySelector('.rf-cover')?.getAttribute('style') ?? ''
    expect(style).toContain('--rf-cover-h: 40vh')
    expect(style).toContain('background-color')
  })

  it('незаданный размер не печатается', () => {
    const { container } = render(
      <>
        <CoverBand cover={{ imageKey: 'ws/a.jpg' }} />
        <LogoMark logo={{ imageKey: 'ws/logo.png', width: 140 }} />
      </>,
    )
    expect(container.querySelector('.rf-cover')?.getAttribute('style')).toBeFalsy()
    const logo = container.querySelector('.rf-logo')?.getAttribute('style') ?? ''
    expect(logo).toContain('--rf-logo-w')
    expect(logo).not.toContain('--rf-logo-h')
    expect(logo).not.toContain('--rf-logo-radius')
  })
})
