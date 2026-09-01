// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import { SCHEMA_VERSION } from '@entities/formSchema'
import { ApiError } from '../../../shared/api/errors'
import { createBuilderStore } from '../builder/store'
import { BuilderStoreContext } from '../builder/storeContext'
import { createFocusEngine, FocusEngineProvider } from '../builder/focusEngine'
import { SlashEditor } from '../builder/SlashEditor'

// Сборка формы по описанию проверяется НА ПОЛОТНЕ, а не на голом диалоге: решение
// «показывать строку» принимает пустое полотно, и оно же решает, что строки нет,
// когда сборку не подключили (маршрут её не дал).

afterEach(cleanup)

function setup(onGenerate?: (prompt: string) => Promise<void>) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks: [] })
  const engine = createFocusEngine()
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <BuilderStoreContext.Provider value={store}>
          <FocusEngineProvider value={engine}>
            <SlashEditor
              formId="f"
              engine={engine}
              onOpenDesign={() => {}}
              onGenerate={onGenerate}
            />
          </FocusEngineProvider>
        </BuilderStoreContext.Provider>
      </QueryClientProvider>
    ),
  })
  const child = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([child('/templates'), child('/settings/plan')]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(<RouterProvider router={router as never} />)
}

async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Собрать по описанию' }))
  return screen.getByRole('dialog')
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText('Что за форма'), { target: { value: text } })
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Собрать форму' }))
}

// Отказ разбирается по коду конверта, а не по тексту: текст меняется, код — контракт.
function apiError(status: number, code: string, message = 'сообщение бэка') {
  return new ApiError(status, code, message)
}

describe('сборка формы по описанию', () => {
  it('строки нет, пока сборку не подключили', async () => {
    setup()
    await screen.findByText('Использовать шаблон')
    expect(screen.queryByText('Собрать по описанию')).toBeNull()
  })

  it('описание уезжает обрезанным, диалог закрывается после удачи', async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined)
    setup(onGenerate)
    await openDialog()

    type('  анкета записи в барбершоп  ')
    await act(async () => submit())

    expect(onGenerate).toHaveBeenCalledWith('анкета записи в барбершоп')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('пустое описание не отправляется', async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined)
    setup(onGenerate)
    await openDialog()

    type('   ')
    expect(screen.getByRole('button', { name: 'Собрать форму' }).hasAttribute('disabled')).toBe(true)
    await act(async () => submit())
    expect(onGenerate).not.toHaveBeenCalled()
  })

  // Пока модель работает, закрыть диалог нельзя: вызов уже оплачен, и уводить
  // человека от результата некуда.
  it('во время работы поле и кнопки заперты', async () => {
    let release: (() => void) | undefined
    const onGenerate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    setup(onGenerate)
    await openDialog()
    type('анкета')
    await act(async () => submit())

    expect(screen.getByRole('button', { name: 'Собираю…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Отмена' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Что за форма').hasAttribute('disabled')).toBe(true)
    expect(document.body.textContent).toContain('Обычно 10–25 секунд')

    await act(async () => {
      release?.()
    })
  })

  it('исчерпанная квота ведёт на страницу тарифа', async () => {
    setup(vi.fn().mockRejectedValue(apiError(402, 'plan_required')))
    await openDialog()
    type('анкета')
    await act(async () => submit())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('кончились')
    expect(screen.getByRole('link', { name: 'Посмотреть тариф' }).getAttribute('href')).toBe(
      '/settings/plan',
    )
    // Диалог остаётся открытым: описание автора не потеряно.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('контур без модели объясняет это, а не показывает поломку', async () => {
    setup(vi.fn().mockRejectedValue(apiError(404, 'not_found')))
    await openDialog()
    type('анкета')
    await act(async () => submit())

    expect((await screen.findByRole('alert')).textContent).toContain('не настроена')
    expect(screen.queryByRole('link', { name: 'Посмотреть тариф' })).toBeNull()
  })

  it('отказ модели показывается словами бэка', async () => {
    setup(
      vi
        .fn()
        .mockRejectedValue(
          apiError(503, 'unavailable', 'модель сейчас не отвечает, попробуйте ещё раз'),
        ),
    )
    await openDialog()
    type('анкета')
    await act(async () => submit())

    expect((await screen.findByRole('alert')).textContent).toContain('модель сейчас не отвечает')
  })

  it('неизвестный отказ не показывает внутренностей', async () => {
    setup(vi.fn().mockRejectedValue(new Error('boom')))
    await openDialog()
    type('анкета')
    await act(async () => submit())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Не удалось собрать форму')
    expect(alert.textContent).not.toContain('boom')
  })
})
