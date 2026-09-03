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

  it('выбор времени берёт холд и показывает выбранное', async () => {
    const hold = vi.fn(() => Promise.resolve({ bookingId: 'bk-7' }))
    render(<Harness src={source({ hold })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: at('2026-09-10T08:00:00Z') }))
    await settle()

    expect(hold).toHaveBeenCalledWith({ startsAt: '2026-09-10T08:00:00Z', seats: 1 })
    expect(screen.getByRole('button', { name: 'Выбрать другое время' })).toBeTruthy()
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
