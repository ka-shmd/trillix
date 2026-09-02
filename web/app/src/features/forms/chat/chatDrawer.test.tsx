// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import { SCHEMA_VERSION, textFromString, type FormSchema } from '@entities/formSchema'
import { ApiError } from '../../../shared/api/errors'
import { planKeys } from '../../plan/keys'
import { workspaceKeys } from '../../workspaces/keys'
import { createBuilderStore } from '../builder/store'
import { BuilderStoreContext } from '../builder/storeContext'
import { ChatDrawer } from './ChatDrawer'
import * as api from './api'

// Шторка проверяется целиком, с настоящим стором полотна: главное, что она делает, —
// кладёт присланный документ на полотно ОДНИМ шагом истории, и проверить это можно
// только через стор.

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof api>()),
  sendChatMessage: vi.fn(),
}))

const sendChatMessage = vi.mocked(api.sendChatMessage)

const START: FormSchema['blocks'] = [
  { id: 'blk_c', groupId: 'g1', type: 'title', text: textFromString('Ваше имя') },
  { id: 'blk_n', groupId: 'g1', type: 'short_text' },
]

const EDITED: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    ...START,
    { id: 'blk_c2', groupId: 'g2', type: 'title', text: textFromString('Телефон') },
    { id: 'blk_p', groupId: 'g2', type: 'phone' },
  ],
}

afterEach(cleanup)
beforeEach(() => {
  sendChatMessage.mockReset()
  localStorage.clear()
})

// Маршрутизатор рендерит дерево асинхронно, поэтому setup ждёт поле ввода: без
// ожидания тело документа ещё пусто.
// Снимок тарифа кладётся в кэш ГОТОВЫМ: шторка показывает остаток сообщений, а
// сетевых запросов в тестах нет. used задаётся тестом — им и проверяется индикатор.
function seedPlan(qc: QueryClient, used: number, limit: number | null = 30) {
  qc.setQueryData(workspaceKeys.list(), [
    { id: 'ws-1', slug: 'personal', name: 'Личное', isPersonal: true, formCount: 1 },
  ])
  qc.setQueryData(planKeys.snapshot('ws-1'), {
    planCode: 'free',
    planTitle: 'Бесплатный',
    periodEnd: '2026-10-01T00:00:00Z',
    features: [
      {
        key: 'ai_generations',
        title: 'Сообщений ассистенту в месяц',
        kind: 'quota',
        allowed: true,
        used,
        limit,
      },
    ],
  })
}

async function setup(formId = 'form-1', used = 2) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks: START })
  const ensureFormId = vi.fn().mockResolvedValue('created-1')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seedPlan(qc, used)

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <BuilderStoreContext.Provider value={store}>
          <ChatDrawer open onOpenChange={() => {}} formId={formId} ensureFormId={ensureFormId} />
        </BuilderStoreContext.Provider>
      </QueryClientProvider>
    ),
  })
  const planRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/plan',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([planRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
  await screen.findByLabelText('Сообщение ассистенту')
  return { store, ensureFormId, qc }
}

function ask(text: string) {
  fireEvent.change(screen.getByLabelText('Сообщение ассистенту'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: /Отправить/ }))
}

describe('шторка ассистента', () => {
  it('правка ложится на полотно одним шагом истории', async () => {
    sendChatMessage.mockResolvedValue({ reply: 'Добавил телефон.', schema: EDITED })
    const { store } = await setup()

    await act(async () => ask('добавь телефон'))

    expect(await screen.findByText('Добавил телефон.')).toBeTruthy()
    expect(store.getState().blocks).toHaveLength(4)
    // Ctrl+Z возвращает как было: подтверждать правку отдельной кнопкой незачем.
    act(() => void store.getState().undo())
    expect(store.getState().blocks).toHaveLength(2)
  })

  it('ответ словами полотно не трогает', async () => {
    sendChatMessage.mockResolvedValue({ reply: 'В форме один вопрос: имя.' })
    const { store } = await setup()

    await act(async () => ask('что тут спрашивается?'))

    expect(await screen.findByText('В форме один вопрос: имя.')).toBeTruthy()
    expect(store.getState().blocks).toHaveLength(2)
  })

  it('форма заводится по первой реплике, если её ещё нет', async () => {
    sendChatMessage.mockResolvedValue({ reply: 'Собрал.', schema: EDITED })
    const { ensureFormId } = await setup('')

    await act(async () => ask('собери анкету'))

    expect(ensureFormId).toHaveBeenCalled()
    expect(sendChatMessage.mock.calls[0]?.[0]).toBe('created-1')
  })

  // Причину отказа по тарифу называет СЕРВЕР: их два рода (кончились сообщения,
  // упёрлись в платное оформление), и своя фраза врала бы на одном из них.
  it('отказ по тарифу ведёт на тариф своим текстом, а реплика автора остаётся в ленте', async () => {
    sendChatMessage.mockRejectedValue(
      new ApiError(402, 'plan_required', 'цвета — платная возможность, на этом тарифе она недоступна'),
    )
    await setup()

    await act(async () => ask('добавь телефон'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('цвета — платная возможность')
    expect(screen.getByText('добавь телефон')).toBeTruthy()

    // Разговор о тарифе — общим оверлеем, а не уходом из редактора по ссылке.
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть тарифы' }))
    expect(await screen.findByText('Это на платном тарифе')).toBeTruthy()
  })

  // Часть просьбы, отсечённая тарифом, приходит УДАЧЕЙ: правка сделана, платное — нет.
  // Разговор о тарифе предлагается у той реплики, в которой это сказано, и признак
  // берётся флагом ответа, а не разбором слов ассистента.
  it('срезанное тарифом предлагает тариф оверлеем у своей реплики', async () => {
    sendChatMessage.mockResolvedValue({
      reply: 'Правки вопросов применил. Цвета — платная возможность.',
      schema: EDITED,
      planRequired: true,
    })
    await setup()

    await act(async () => ask('добавь телефон и покрась в синий'))

    expect(await screen.findByText(/Правки вопросов применил/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть тарифы' }))
    expect(await screen.findByText('Это на платном тарифе')).toBeTruthy()
  })

  it('удачный ответ без тарифного отказа тариф не предлагает', async () => {
    sendChatMessage.mockResolvedValue({ reply: 'Добавил телефон.', schema: EDITED })
    await setup()

    await act(async () => ask('добавь телефон'))

    await screen.findByText('Добавил телефон.')
    expect(screen.queryByRole('button', { name: 'Посмотреть тарифы' })).toBeNull()
  })

  // Остаток сообщений автор видит ДО того, как упрётся в отказ. Число берётся из
  // снимка тарифа (расход живёт на пространстве, а не в шторке) и пересчитывается
  // после каждой реплики: списание произошло на сервере, кэш устарел ровно тогда.
  it('остаток сообщений виден и обновляется после реплики', async () => {
    sendChatMessage.mockResolvedValue({ reply: 'Готово.' })
    const { qc } = await setup('form-1', 2)

    expect(screen.getByText('Осталось 28 из 30 сообщений в этом месяце')).toBeTruthy()

    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await act(async () => ask('добавь телефон'))

    await screen.findByText('Готово.')
    expect(
      invalidate.mock.calls.some(
        (c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(planKeys.snapshot('ws-1')),
      ),
    ).toBe(true)
  })

  it('исчерпанный остаток зовёт к тарифу оверлеем', async () => {
    await setup('form-1', 30)

    expect(screen.getByText(/Сообщения на этом тарифе кончились/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть тарифы' }))
    expect(await screen.findByText('Это на платном тарифе')).toBeTruthy()
  })

  it('отказ модели показывается словами бэка', async () => {
    sendChatMessage.mockRejectedValue(new ApiError(503, 'unavailable', 'модель сейчас не отвечает'))
    await setup()

    await act(async () => ask('добавь телефон'))

    expect((await screen.findByRole('alert')).textContent).toContain('модель сейчас не отвечает')
  })

  it('разговор переживает переоткрытие шторки', async () => {
    sendChatMessage.mockResolvedValue({ reply: 'Готово.' })
    await setup()
    await act(async () => ask('привет'))
    await screen.findByText('Готово.')

    cleanup()
    await setup()

    expect(await screen.findByText('Готово.')).toBeTruthy()
    expect(screen.getByText('привет')).toBeTruthy()
  })

  it('Enter отправляет, Shift+Enter — нет', async () => {
    sendChatMessage.mockResolvedValue({ reply: 'Ага.' })
    await setup()
    const input = screen.getByLabelText('Сообщение ассистенту')

    fireEvent.change(input, { target: { value: 'первое' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(sendChatMessage).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1))
  })
})
