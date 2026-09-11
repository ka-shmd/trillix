// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { FormFactsProvider, type FormFacts } from './formFacts'
import { SlotControl } from './kinds/slotControl'

// Запись на полотне без расписания: заглушка гаснет, поверх неё — плашка с быстрым
// выбором (решение владельца 2026-09-11). Сторожится развилка «выбрано / не выбрано /
// неизвестно» и то, что список расписаний спрашивает только плашка: у настроенного
// блока полотну он не нужен.

// Одно расписание, а не пустой список: при пустом плашка сменила бы «Выбрать» на ссылку
// «Завести расписание», а ей нужен роутер, которого здесь нет.
const schedule = {
  id: 'sch-1',
  workspaceId: 'ws-1',
  name: 'Мария — рисование',
  timezone: 'Europe/Moscow',
  availability: { weekly: {}, exceptions: [] },
  slotMinutes: 60,
  bufferMinutes: 0,
  horizonDays: 30,
  leadMinutes: 0,
  capacity: 1,
  maxSeatsPerBooking: 1,
  showRemaining: false,
  createdAt: '2026-09-03T10:00:00Z',
  updatedAt: '2026-09-03T10:00:00Z',
}

let calls: string[] = []

beforeEach(() => {
  calls = []
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    calls.push(String(input))
    return Promise.resolve(
      new Response(JSON.stringify({ items: [schedule] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
})

afterEach(cleanup)

function renderWith(facts: FormFacts | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const control = <SlotControl />
  return render(
    <QueryClientProvider client={qc}>
      {facts ? <FormFactsProvider value={facts}>{control}</FormFactsProvider> : control}
    </QueryClientProvider>,
  )
}

const base = { id: 'form-1', workspaceId: 'ws-1', workspaceSlug: 'w-one' }

describe('запись на полотне без расписания', () => {
  it('расписание не выбрано — плашка с выбором поверх погашенной заглушки', async () => {
    const { container } = renderWith({ ...base, scheduleId: null })

    expect(screen.getByText('Расписание не выбрано')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Выбрать/ })).not.toBeNull()
    expect(container.querySelector('.grayscale .rf-slots')).not.toBeNull()
    await waitFor(() => expect(calls[0]).toContain('/workspaces/ws-1/schedules'))
    // После загрузки списка кнопка остаётся выбором, а не уходит в «Завести».
    await waitFor(() => expect(screen.getByRole('button', { name: /Выбрать/ })).not.toBeNull())
  })

  it('расписание выбрано — заглушка как у респондента, списка не спрашиваем', () => {
    const { container } = renderWith({ ...base, scheduleId: 'sch-1' })

    expect(screen.queryByText('Расписание не выбрано')).toBeNull()
    expect(container.querySelector('.grayscale')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('вне полотна (фактов нет) — состояние неизвестно, плашки нет', () => {
    renderWith(null)
    expect(screen.queryByText('Расписание не выбрано')).toBeNull()
  })
})
