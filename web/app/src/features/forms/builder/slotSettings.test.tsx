// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { FormFactsProvider, type FormFacts } from './formFacts'
import { SlotSettings } from './kinds/slotSettings'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { type Block } from '@entities/formSchema'

// Попап блока «Запись» спрашивает расписания ПРОСТРАНСТВА ФОРМЫ. Дважды за один день
// он показывал пустой список при заведённом расписании (отчёт владельца 2026-09-03):
// сперва потому, что расписание уходило в другое пространство, потом — потому что у
// только что созданной формы в кэше не было workspaceId, и запрос не включался вовсе.
//
// Тест сторожит именно ЭТО: с каким пространством уходит запрос и уходит ли он.
// Разметку выпадающего списка он не трогает — Radix рисует пункты только открытым, а
// проверять надо не это.

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
    const url = String(input)
    calls.push(url)
    return Promise.resolve(
      new Response(JSON.stringify({ items: [schedule] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
})

afterEach(cleanup)

// Попапу нужен стор билдера: он смотрит в документ — есть ли обязательный вопрос о
// почте. Блоками по умолчанию считается «есть», чтобы проверки про расписание не
// спотыкались о второе предупреждение.
function renderWith(facts: FormFacts, blocks: Block[] = [emailBlock(true)]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const store = createBuilderStore()
  store.setState({ blocks })
  return render(
    <QueryClientProvider client={qc}>
      <BuilderStoreContext.Provider value={store}>
        <FormFactsProvider value={facts}>
          <SlotSettings />
        </FormFactsProvider>
      </BuilderStoreContext.Provider>
    </QueryClientProvider>,
  )
}

function emailBlock(required: boolean): Block {
  return { id: 'e1', groupId: 'g1', type: 'email', required } as Block
}

describe('расписание в попапе блока «Запись»', () => {
  it('спрашивает расписания ПРОСТРАНСТВА ФОРМЫ, а не «вообще»', async () => {
    renderWith({ id: 'form-1', workspaceId: 'ws-1', workspaceSlug: 'w-one', scheduleId: null })

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls[0]).toContain('/workspaces/ws-1/schedules')
  })

  it('расписание есть — про «нет расписаний» не пишем', async () => {
    renderWith({ id: 'form-1', workspaceId: 'ws-1', workspaceSlug: 'w-one', scheduleId: null })

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await waitFor(() => {
      expect(screen.queryByText(/ещё нет расписаний/)).toBeNull()
    })
    // Про «нельзя опубликовать» этот попап больше не говорит вовсе: условий два, и
    // оба живут на кнопке «Опубликовать» (publishGate.test.ts).
    expect(screen.queryByText(/нельзя опубликовать/)).toBeNull()
  })

  it('пространство формы неизвестно — запроса нет вовсе', () => {
    // Так выглядела только что созданная форма: деталь собрана из короткой карточки
    // ответа POST, где пространства нет. Запрос с пустым id ушёл бы в /workspaces//…
    // и вернул бы 404 — молча, потому что попап показывает пустой список одинаково.
    renderWith({ id: 'form-1', workspaceId: '', workspaceSlug: '', scheduleId: null })
    expect(calls).toHaveLength(0)
  })
})
