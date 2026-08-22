// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import { formDetailSchema } from '../../entities/form'
import { createBuilderStore } from './builder/store'
import { BuilderStoreContext } from './builder/storeContext'
import { createFocusEngine, FocusEngineProvider } from './builder/focusEngine'
import { SlashEditor } from './builder/SlashEditor'
import { newFormDetail } from './draft'

// Деталь несозданной формы — ЗЕРКАЛО ответа сервера, и врёт она молча: полотно
// смонтируется на чём угодно, а не хватит в этом зеркале ровно того, чего сервер
// добавляет от себя. Так пропала строка заголовка формы: она не колонка и не дефолт
// базы, а блок, который дописывает ЧТЕНИЕ черновика (`domain.EnsureFormTitle`), — в
// пустом `blocks: []` его нет, и первая строка полотна у новой формы исчезала.

afterEach(cleanup)

// Полотно живёт в маршруте: у приглашения пустого полотна есть ссылка на /templates,
// а Link без роутера не рисуется (тот же приём, что в emptyCanvas.test.tsx).
function renderCanvas() {
  const store = createBuilderStore()
  store.getState().hydrate(newFormDetail().draftSchema)
  const engine = createFocusEngine()
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <BuilderStoreContext.Provider value={store}>
          <FocusEngineProvider value={engine}>
            <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
          </FocusEngineProvider>
        </BuilderStoreContext.Provider>
      </QueryClientProvider>
    ),
  })
  const templatesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/templates',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([templatesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(<RouterProvider router={router as never} />)
  return { store }
}

describe('деталь несозданной формы', () => {
  it('проходит ту же схему, что ответ сервера', () => {
    // Zod здесь не украшение: поле, забытое в зеркале или уехавшее в контракте,
    // роняет тест, а не рисует полотно с дырой.
    expect(() => formDetailSchema.parse(newFormDetail())).not.toThrow()
  })

  it('несёт строку заголовка формы — её сервер дописывает на чтении', async () => {
    renderCanvas()

    expect(await screen.findByLabelText('Название формы')).toBeTruthy()
  })

  it('кроме заголовка полотно пусто — приглашение начать на месте', async () => {
    const { store } = renderCanvas()

    expect(store.getState().blocks.map((b) => b.type)).toEqual(['form_title'])
    expect(await screen.findByText('Использовать шаблон')).toBeTruthy()
  })
})
