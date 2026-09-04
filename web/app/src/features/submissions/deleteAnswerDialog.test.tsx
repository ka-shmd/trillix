// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DeleteAnswerDialog } from './DeleteAnswerDialog'
import { listRow } from './rows'
import { type Submission } from '../../entities/submission'

// ОТКАЗ УДАЛЕНИЯ ОБЪЯСНЯЕТСЯ СЛОВАМИ СЕРВЕРА. Отказы здесь бывают осмысленные: живая
// будущая запись держит ответ (стоп-кран фазы 27), и сервер говорит, что делать.
// Общее «попробуйте ещё раз» на этом месте врёт — повтор не поможет никогда
// (отчёт владельца 2026-09-04: 409 он увидел в консоли, а не на экране).

afterEach(cleanup)

const row = listRow({
  kind: 'submission',
  id: 'sub-1',
  formVersion: 1,
  createdAt: '2026-09-04T08:50:00Z',
  lastBlockId: '',
  answers: {},
} as Submission)

function renderWith(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response)),
  )
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DeleteAnswerDialog formId="f1" row={row} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  )
}

function refuse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('окно удаления ответа', () => {
  it('показывает причину отказа сервера, а не общую фразу', async () => {
    renderWith(
      refuse(
        409,
        'conflict',
        'на этот ответ есть будущая запись — сначала отмените её в расписании',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('сначала отмените её в расписании')
    })
  })

  it('отказ без человеческого текста не показывает латиницу', async () => {
    renderWith(refuse(500, 'internal', 'internal'))

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Не удалось удалить. Попробуйте ещё раз.')
    })
  })
})
