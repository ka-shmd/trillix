// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TimeField } from './TimeField'

afterEach(cleanup)

// Контрол свой (у shadcn тайм-пикера нет), поэтому его поведение держат тесты, а не
// чужая библиотека: 24 часа, ввод цифрами подряд, стрелки по кругу, потолки сегментов.
describe('поле времени', () => {
  const setup = (value = '') => {
    const onChange = vi.fn()
    render(<TimeField value={value} onChange={onChange} />)
    return {
      onChange,
      hours: screen.getByLabelText('Часы') as HTMLInputElement,
      minutes: screen.getByLabelText('Минуты') as HTMLInputElement,
    }
  }

  it('добирает нули: одна цифра — уже время', () => {
    const { onChange, hours } = setup('')
    fireEvent.change(hours, { target: { value: '9' } })
    expect(onChange).toHaveBeenCalledWith('09:00')
  })

  it('часы выше 23 и минуты выше 59 обрезаются потолком, а не отвергаются', () => {
    const { onChange, hours } = setup('')
    fireEvent.change(hours, { target: { value: '99' } })
    expect(onChange).toHaveBeenCalledWith('23:00')

    cleanup()
    const second = setup('10:00')
    fireEvent.change(second.minutes, { target: { value: '99' } })
    expect(second.onChange).toHaveBeenCalledWith('10:59')
  })

  it('вторая цифра часов переводит в минуты', () => {
    const { hours, minutes } = setup('')
    fireEvent.change(hours, { target: { value: '23' } })
    expect(document.activeElement).toBe(minutes)
  })

  it('цифра, после которой часа не бывает, переводит сразу', () => {
    // «3» — это уже 03: второй цифры не будет, и ждать её значит требовать лишнего
    // нажатия у каждого времени после трёх часов.
    const { hours, minutes } = setup('')
    fireEvent.change(hours, { target: { value: '3' } })
    expect(document.activeElement).toBe(minutes)
  })

  it('стрелки крутят по кругу, а не упираются в стенку', () => {
    const { onChange, hours } = setup('23:30')
    act(() => {
      fireEvent.keyDown(hours, { key: 'ArrowUp' })
    })
    expect(onChange).toHaveBeenCalledWith('00:30')

    cleanup()
    const midnight = setup('00:30')
    act(() => {
      fireEvent.keyDown(midnight.hours, { key: 'ArrowDown' })
    })
    expect(midnight.onChange).toHaveBeenCalledWith('23:30')
  })

  it('печатать поверх можно без стирания: берутся последние две цифры', () => {
    const { onChange, minutes } = setup('10:45')
    fireEvent.change(minutes, { target: { value: '4515' } })
    expect(onChange).toHaveBeenCalledWith('10:15')
  })
})
