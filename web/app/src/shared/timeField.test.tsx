// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { TimeField } from './TimeField'

afterEach(cleanup)

// Контрол свой (тайм-пикера у shadcn нет), поэтому его поведение держат тесты, а не
// чужая библиотека. Проверяется то, что ломается молча: 24 часа на кнопке, выбор
// строки колеса, клавиатура по кругу и назначение значения по остановке прокрутки.
describe('поле времени', () => {
  const openPanel = (value = '10:30') => {
    const onChange = vi.fn()
    render(<TimeField value={value} onChange={onChange} />)
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /:/ }))
    })
    return { onChange }
  }

  it('на кнопке 24 часа, а не «PM»', () => {
    render(<TimeField value="23:05" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /23:05/ })).toBeTruthy()
  })

  it('время не выбирали — на кнопке подпись, а не «00:00»', () => {
    render(<TimeField value="" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Время' })).toBeTruthy()
  })

  it('выбор строки колеса меняет только свой сегмент', () => {
    const { onChange } = openPanel('10:30')
    // «07» есть в обоих колёсах (часы и минуты) — ищем внутри своего, иначе тест
    // проверял бы, какое из них попалось первым.
    const hours = within(screen.getByRole('listbox', { name: 'Часы' }))
    act(() => {
      fireEvent.click(hours.getByRole('option', { name: '07' }))
    })
    expect(onChange).toHaveBeenCalledWith('07:30')
  })

  it('стрелки крутят колесо по кругу, а не упираются в край', () => {
    const { onChange } = openPanel('23:30')
    const hours = screen.getByRole('listbox', { name: 'Часы' })
    act(() => {
      fireEvent.keyDown(hours, { key: 'ArrowDown' })
    })
    expect(onChange).toHaveBeenCalledWith('00:30')

    cleanup()
    const midnight = openPanel('00:30')
    act(() => {
      fireEvent.keyDown(screen.getByRole('listbox', { name: 'Часы' }), { key: 'ArrowUp' })
    })
    expect(midnight.onChange).toHaveBeenCalledWith('23:30')
  })

  it('значение назначает строка в центре — после остановки прокрутки', () => {
    vi.useFakeTimers()
    const { onChange } = openPanel('10:30')
    const minutes = screen.getByRole('listbox', { name: 'Минуты' })

    // 45-я строка ленты (высота строки 36) — это «45».
    minutes.scrollTop = 45 * 36
    act(() => {
      fireEvent.scroll(minutes)
    })
    // Пока лента едет, значение НЕ меняется: инерция шлёт события пачкой, и на каждом
    // пересчитывался бы весь черновик страницы.
    expect(onChange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onChange).toHaveBeenCalledWith('10:45')
    vi.useRealTimers()
  })
})
