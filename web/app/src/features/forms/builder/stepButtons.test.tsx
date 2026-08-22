// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import { TooltipProvider } from '@/components/ui/tooltip'

import { type FormSchema, SCHEMA_VERSION, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { SlashEditor } from './SlashEditor'

// КНОПКИ ШАГА НА ПОЛОТНЕ (решение владельца 2026-08-22): у каждой страницы своя кнопка
// «Далее», и правятся все кнопки одинаково — карандашом слева, а не кликом по самой
// кнопке. Полотно монтируется целиком: кто где рисует кнопки, решает SlashEditor, и
// проверка на уровне строки этого не видит (тот же довод, что у emptyCanvas.test).
//
// Что здесь сторожится, кроме текста:
//   • носитель текста «Далее» — ЗАКРЫВАЮЩИЙ страницу разрыв (settings.nextLabel), а не
//     форма: две страницы обязаны называть кнопки по-разному, ради чего всё и делалось;
//   • сама кнопка на полотне НЕ нажимается (span, показ) — иначе автор ждал бы от неё
//     перехода, которого на одном свитке нет.

afterEach(cleanup)

function setup(blocks: FormSchema['blocks']) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  const engine = createFocusEngine()
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        {/* Как в кабинете: провайдер тултипов даёт SidebarProvider выше по дереву, а
            Radix без него падает на первом же Tooltip строки. */}
        <TooltipProvider>
          <BuilderStoreContext.Provider value={store}>
            <FocusEngineProvider value={engine}>
              <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
            </FocusEngineProvider>
          </BuilderStoreContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/templates', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(<RouterProvider router={router as never} />)
  return { store }
}

const q = (id: string, label: string): FormSchema['blocks'] => [
  { id: `${id}-cap`, groupId: id, type: 'title', text: textFromString(label) },
  { id, groupId: id, type: 'short_text' },
]

const brk = (id: string, nextLabel?: string): FormSchema['blocks'][number] => ({
  id,
  groupId: id,
  type: 'page_break',
  ...(nextLabel === undefined ? {} : { settings: { nextLabel } }),
})

const threePages = (a?: string, b?: string): FormSchema['blocks'] => [
  ...q('q1', 'Имя'),
  brk('pb1', a),
  ...q('q2', 'Почта'),
  brk('pb2', b),
  ...q('q3', 'Комментарий'),
]

// Карандаш правки конкретной кнопки: имя называет ТЕКСТ кнопки, поэтому по нему же
// кнопки и различаются на полотне.
const pencil = (label: string) =>
  screen.getByRole('button', { name: `Изменить текст кнопки «${label}»` })

describe('кнопки шага на полотне', () => {
  it('без своего текста кнопки зовутся дефолтами', async () => {
    setup(threePages())
    // Две страницы кончаются «Далее», последняя — отправкой.
    expect((await screen.findAllByText('Далее')).length).toBe(2)
    expect(screen.getByText('Отправить')).toBeTruthy()
  })

  it('текст «Далее» берётся у закрывающего страницу разрыва — у каждой страницы свой', async () => {
    setup(threePages('Продолжить', 'К оплате'))
    expect(await screen.findByText('Продолжить')).toBeTruthy()
    expect(screen.getByText('К оплате')).toBeTruthy()
    expect(screen.queryByText('Далее')).toBeNull()
  })

  it('кнопка на полотне — показ, а не контрол: нажимать её нечем', async () => {
    setup(threePages('Продолжить'))
    const shown = await screen.findByText('Продолжить')
    expect(shown.tagName).toBe('SPAN')
    // И у отправки то же самое: клик по САМОЙ кнопке текст больше не правит.
    expect(screen.getByText('Отправить').tagName).toBe('SPAN')
  })

  it('карандаш правит «Далее» СВОЕЙ страницы, а не всех сразу', async () => {
    const { store } = setup(threePages('Продолжить', 'К оплате'))
    await screen.findByText('Продолжить')

    fireEvent.click(pencil('К оплате'))
    fireEvent.change(screen.getByLabelText('Текст кнопки перехода'), {
      target: { value: 'Оплатить' },
    })

    const settings = (id: string) =>
      store.getState().blocks.find((b) => b.id === id)?.settings?.nextLabel
    expect(settings('pb2')).toBe('Оплатить')
    expect(settings('pb1')).toBe('Продолжить')
  })

  it('карандаш отправки правит форма-уровневый текст', async () => {
    const { store } = setup(threePages())
    await screen.findByText('Отправить')

    fireEvent.click(pencil('Отправить'))
    fireEvent.change(screen.getByLabelText('Текст кнопки отправки'), {
      target: { value: 'Готово' },
    })

    expect(store.getState().submitLabel).toBe('Готово')
    expect(screen.getByText('Готово')).toBeTruthy()
  })

  it('стёртый до конца текст возвращает дефолт, а не пустую кнопку', async () => {
    setup(threePages('Продолжить', 'К оплате'))
    await screen.findByText('Продолжить')

    fireEvent.click(pencil('Продолжить'))
    fireEvent.change(screen.getByLabelText('Текст кнопки перехода'), { target: { value: '' } })

    // Пустое значение = «своего текста нет», и кнопка зовётся дефолтом. Сосед при этом
    // не трогается: носители разные.
    expect(screen.getByText('Далее')).toBeTruthy()
    expect(screen.getByText('К оплате')).toBeTruthy()
  })
})
