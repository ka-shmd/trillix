// @vitest-environment happy-dom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { HOLD_CONFLICT, type FreeSlot, type SlotSource } from '@fields/booking'
import SlotPicker from '@fields/slots/SlotPicker'

afterEach(cleanup)

const slot = (startsAt: string, remaining = 1): FreeSlot => ({ startsAt, remaining })

// Источник — подставной: живой поход на публичную ручку означал бы тест, зелёный
// только при поднятом сервере.
function source(over: Partial<SlotSource> = {}): SlotSource {
  return {
    timezone: 'Europe/Moscow',
    maxSeats: 1,
    showRemaining: false,
    list: () => Promise.resolve([slot('2026-09-10T08:00:00Z'), slot('2026-09-10T09:00:00Z')]),
    hold: () => Promise.resolve({ bookingId: 'bk-1' }),
    ...over,
  }
}

// Обёртка со своим value: пикер управляемый, и без неё выбранное время не доехало бы
// до разметки — проверялся бы вызов onChange, а не то, что видит респондент.
function Harness({ src }: { src: SlotSource }) {
  const [value, setValue] = useState('')
  return (
    <SlotPicker source={src} value={value} onChange={setValue} label="Время" invalid={false} />
  )
}

// Времена подписаны поясом машины, где идёт тест: жёсткое «11:00» падало бы в CI.
const at = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('выбор времени', () => {
  it('показывает свободные времена первого дня', async () => {
    render(<Harness src={source()} />)
    await settle()

    expect(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') })).toBeTruthy()
    expect(screen.getByRole('button', { name: at('2026-09-10T09:00:00Z') })).toBeTruthy()
  })

  it('выбор времени берёт холд и подсвечивает выбранное, не подменяя блок', async () => {
    const hold = vi.fn(() => Promise.resolve({ bookingId: 'bk-7' }))
    render(<Harness src={source({ hold })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') }))
    await settle()

    expect(hold).toHaveBeenCalledWith({ startsAt: '2026-09-10T08:00:00Z', seats: 1 })
    // Сетка осталась на месте: соседнее время по-прежнему предлагается, а выбранное
    // отмечено нажатым.
    const chosen = screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') })
    expect(chosen.getAttribute('aria-pressed')).toBe('true')
    expect(
      screen
        .getByRole('button', { name: at('2026-09-10T09:00:00Z') })
        .getAttribute('aria-pressed'),
    ).toBe('false')
    expect(screen.getByText(/Выбрано:/)).toBeTruthy()
  })

  it('повторный клик по выбранному времени очищает ответ, а не только подсветку', async () => {
    // РЕГРЕССИЯ. Первая редакция гасила только показ: значение оставалось прежним id
    // брони. Респондент, передумавший и не выбравший ничего взамен, отправлял форму со
    // старой бронью — экран показывал список, а сервер подтверждал живой холд.
    const seen: string[] = []
    function Spy({ src }: { src: SlotSource }) {
      const [value, setValue] = useState('')
      seen.push(value)
      return (
        <SlotPicker source={src} value={value} onChange={setValue} label="Время" invalid={false} />
      )
    }
    render(<Spy src={source({ hold: () => Promise.resolve({ bookingId: 'bk-9' }) })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') }))
    await settle()
    expect(seen.at(-1)).toBe('bk-9')

    fireEvent.click(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') }))
    await settle()
    expect(seen.at(-1)).toBe('')
    expect(
      screen
        .getByRole('button', { name: at('2026-09-10T08:00:00Z') })
        .getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('смена числа мест роняет уже взятый холд', async () => {
    // Холд взят НА ПРЕЖНЕЕ ЧИСЛО МЕСТ, и блок при выборе больше не подменяется —
    // селект остаётся доступным. Оставь ответ прежним, и в письме поедет бронь на одно
    // место у того, кто выбрал три.
    const seen: string[] = []
    function Spy({ src }: { src: SlotSource }) {
      const [value, setValue] = useState('')
      seen.push(value)
      return (
        <SlotPicker source={src} value={value} onChange={setValue} label="Время" invalid={false} />
      )
    }
    render(<Spy src={source({ maxSeats: 3 })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') }))
    await settle()
    expect(seen.at(-1)).toBe('bk-1')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } })
    await settle()
    expect(seen.at(-1)).toBe('')
  })

  it('занятое время объясняется словами сервиса, а не кодом ошибки', async () => {
    const hold = vi.fn(() => Promise.reject(new Error(HOLD_CONFLICT)))
    render(<Harness src={source({ hold })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') }))
    await settle()

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Это время только что заняли')
  })

  it('слот, куда запрошенные места не влезают, погашен', async () => {
    render(
      <Harness
        src={source({
          maxSeats: 3,
          list: () =>
            Promise.resolve([slot('2026-09-10T08:00:00Z', 1), slot('2026-09-10T09:00:00Z', 5)]),
        })}
      />,
    )
    await settle()

    // Просим три места: в слот с остатком 1 они не влезают.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } })
    expect(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: at('2026-09-10T09:00:00Z') })).toHaveProperty(
      'disabled',
      false,
    )
  })

  it('пустая выдача говорит словами, а не пустотой', async () => {
    render(<Harness src={source({ list: () => Promise.resolve([]) })} />)
    await settle()

    expect(screen.getByText(/Свободного времени сейчас нет/)).toBeTruthy()
  })

  it('сбой выдачи даёт кнопку повтора, а не молчание', async () => {
    render(<Harness src={source({ list: () => Promise.reject(new Error('500')) })} />)
    await settle()

    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
  })
})

describe('лента дат', () => {
  // Сутки берутся МЕСТНЫЕ, а не фиксированный UTC: лента режется по календарю
  // читателя, и жёсткая дата уехала бы на день в CI с другим TZ.
  const inDays = (offset: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    d.setHours(hour, 0, 0, 0)
    return d.toISOString()
  }

  it('день без свободного времени стоит в ленте погашенным', async () => {
    const list = () => Promise.resolve([slot(inDays(0, 9)), slot(inDays(2, 9))])
    render(<Harness src={source({ list })} />)
    await settle()

    const days = screen.getAllByRole('tab')
    expect(days).toHaveLength(3)
    expect(days[0]).toHaveProperty('disabled', false)
    expect(days[1]).toHaveProperty('disabled', true)
    expect(days[2]).toHaveProperty('disabled', false)
  })

  it('листание НЕ трогает выбранный день', async () => {
    // Двенадцать дней ленты: свободны первый и девятый. Человек листает, чтобы
    // посмотреть, — его выбор при этом остаётся на месте, и времена под лентой
    // продолжают показывать выбранный день, а не первый свободный новой страницы.
    const list = () => Promise.resolve([slot(inDays(0, 9)), slot(inDays(8, 15))])
    render(<Harness src={source({ list })} />)
    await settle()

    expect(screen.getByRole('button', { name: at(inDays(0, 9)) })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Следующие дни' }))
    await settle()

    // Лента показала вторую страницу: девятый день в ней есть, первого нет.
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    // А времена — по-прежнему выбранного дня.
    expect(screen.getByRole('button', { name: at(inDays(0, 9)) })).toBeTruthy()
    expect(screen.queryByRole('button', { name: at(inDays(8, 15)) })).toBeNull()
  })

  it('шеврон назад погашен на первой странице', async () => {
    render(<Harness src={source()} />)
    await settle()

    expect(screen.getByRole('button', { name: 'Предыдущие дни' })).toHaveProperty(
      'disabled',
      true,
    )
  })
})
