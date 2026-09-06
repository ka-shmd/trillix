// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import { type FormSchema, SCHEMA_VERSION, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { SlashEditor } from './SlashEditor'
import { WorkspaceAddressProvider } from '../../../shared/workspaceContext'

// Пустое полотно — единственный экран, который новичок видит сразу после «Новая форма»,
// и на нём не должно быть ничего, кроме приглашения начать: кнопка отправки у формы без
// вопросов отправлять нечему, а стоя одна посреди пустой страницы читается как главное
// действие. Приглашение при этом называет ДВА пути — клавиатурный и «взять готовое».
//
// Полотно монтируется целиком (как в canvasBackspace.test.tsx): решение «показывать
// кнопку» принимает SlashEditor, и проверка на уровне строки его не видит.

afterEach(cleanup)

// Полотно живёт в маршруте: у приглашения есть ссылка на /templates, а Link без
// роутера не рисуется. Дерево здесь своё, минимальное, — от настоящего нужен только
// адрес, который Link превращает в href.
function setup(blocks: FormSchema['blocks']) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  const engine = createFocusEngine()
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

  const rootRoute = createRootRoute({
    // Провайдер пространства стоит ВНУТРИ роутера (он читает адрес): ссылка на
    // шаблоны ведёт в галерею текущего пространства, а адрес `/` его не называет —
    // отвечает личное.
    component: () => (
      <WorkspaceAddressProvider personalSlug="ws-1">
        <QueryClientProvider client={qc}>
          <BuilderStoreContext.Provider value={store}>
            <FocusEngineProvider value={engine}>
              <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
            </FocusEngineProvider>
          </BuilderStoreContext.Provider>
        </QueryClientProvider>
      </WorkspaceAddressProvider>
    ),
  })
  const templatesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$workspaceSlug/templates',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([templatesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(<RouterProvider router={router as never} />)
  return { store }
}

const QUESTION: FormSchema['blocks'] = [
  { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
  { id: 'inp', groupId: 'g1', type: 'short_text' },
]

// canvasArea — сама фокусируемая область приглашения (не ссылка внутри неё).
function canvasArea(): HTMLElement {
  return screen.getByText('Использовать шаблон').closest('div')!
}

describe('пустое полотно', () => {
  it('кнопки отправки нет, а с первым блоком она появляется', async () => {
    setup([])
    await screen.findByText('Использовать шаблон')
    expect(screen.queryByText('Отправить')).toBeNull()

    cleanup()
    setup(QUESTION)
    expect(await screen.findByText('Отправить')).toBeTruthy()
  })

  it('приглашение называет оба пути: Enter и шаблон', async () => {
    setup([])
    const link = (await screen.findByText('Использовать шаблон')).closest('a')
    expect(link?.getAttribute('href')).toBe('/w/ws-1/templates')
    expect(document.body.textContent).toContain('Нажмите')
    expect(document.body.textContent).toContain('чтобы начать')
    // «/» и «@» ушли из подсказок в описание — обещать их полотно не перестало, и
    // названы они теми же чипами, что Enter выше (kbd, а не текст в кавычках).
    expect([...document.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Enter',
      '/',
      '@',
    ])
  })

  it('блок заводит кнопка подсказки, а не клик по полотну', async () => {
    // Клик в пустоту не пишет ничего (решение владельца): полотно начинают кнопкой
    // «начать» либо набором — иначе промах по подсказке оставляет на форме пустую
    // строку, которую автор не заводил.
    const { store } = setup([])
    const hint = await screen.findByText('чтобы начать', { exact: false })

    act(() => {
      canvasArea().click()
    })
    expect(store.getState().blocks).toHaveLength(0)

    act(() => {
      hint.closest('button')!.click()
    })
    expect(store.getState().blocks).toHaveLength(1)
  })

  it('Enter на полотне заводит блок, Enter на ссылке — нет', async () => {
    const { store } = setup([])
    await screen.findByText('Использовать шаблон')
    const area = canvasArea()

    // Ссылка лежит внутри области, и её Enter обязан достаться браузеру: иначе клавиша
    // и уводила бы на шаблоны, и оставляла за собой пустой блок.
    act(() => {
      fireEvent.keyDown(screen.getByText('Использовать шаблон'), { key: 'Enter', code: 'Enter' })
    })
    expect(store.getState().blocks).toHaveLength(0)

    act(() => {
      fireEvent.keyDown(area, { key: 'Enter', code: 'Enter' })
    })
    expect(store.getState().blocks).toHaveLength(1)
  })
})
