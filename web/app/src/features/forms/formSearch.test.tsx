// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import { SidebarProvider } from '@/components/ui/sidebar'
import { FormSearch } from './FormSearch'
import { formKeys } from './keys'

afterEach(cleanup)

const HITS = {
  forms: [
    {
      id: 'f-1',
      slug: 'draft01',
      name: null,
      title: 'Анкета читателя',
      status: 'draft' as const,
      // Черновик лежит в КОМАНДНОМ пространстве намеренно: ссылка в редактор
      // обязана брать место из самой строки, а не подставлять личное.
      workspaceSlug: 'team',
      workspaceName: 'Команда',
    },
    {
      id: 'f-2',
      slug: 'live02',
      name: 'Анкета сотрудника',
      title: 'Опрос',
      status: 'published' as const,
      workspaceSlug: 'personal',
      workspaceName: 'Личное пространство',
    },
  ],
}

async function renderSearch() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Выдача кладётся в кэш: предмет проверки — окно и его строки, а не транспорт.
  qc.setQueryData(formKeys.search('анкета'), HITS)

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <SidebarProvider>
          <FormSearch />
          <Outlet />
        </SidebarProvider>
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/w/$workspaceSlug/forms/$slug/edit', '/forms/$slug/responses'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
}

async function type(text: string) {
  const input = screen.getByPlaceholderText('Название формы…')
  await act(async () => {
    fireEvent.change(input, { target: { value: text } })
  })
}

describe('поиск форм по всем пространствам', () => {
  // Сочетание — единственный способ открыть поиск, не целясь в панель, а панель
  // бывает свёрнута в полосу и закрыта шторкой на мобильном.
  it('⌘K открывает окно откуда угодно', async () => {
    await renderSearch()
    expect(screen.queryByPlaceholderText('Название формы…')).toBeNull()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
    })
    expect(screen.getByPlaceholderText('Название формы…')).toBeTruthy()
  })

  // НЕСУЩЕЕ У ВЫДАЧИ — МЕСТО: две одинаково названные формы в разных пространствах
  // различает только оно, а «в каком из них форма» человек как раз и не помнил.
  it('строка результата называет пространство', async () => {
    await renderSearch()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    })
    await type('анкета')

    expect(screen.getByText('Анкета читателя')).toBeTruthy()
    expect(screen.getByText('Личное пространство')).toBeTruthy()
    expect(screen.getByText('Анкета сотрудника')).toBeTruthy()
    expect(screen.getByText('Команда')).toBeTruthy()
  })

  // Куда ведёт результат — то же правило, что у карточки списка: черновик в
  // редактор (он адресуется ЧЕРЕЗ ПРОСТРАНСТВО, и slug места приезжает в самой
  // строке), розданная форма — на ответы.
  it('черновик ведёт в редактор своего пространства, розданная форма — на ответы', async () => {
    await renderSearch()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
    })
    await type('анкета')

    const draft = screen.getByText('Анкета читателя').closest('a')
    expect(draft?.getAttribute('href')).toBe('/w/team/forms/draft01/edit')
    const live = screen.getByText('Анкета сотрудника').closest('a')
    expect(live?.getAttribute('href')).toBe('/forms/live02/responses')
  })

  // Пустой запрос ничего не спрашивает и ничего не показывает: до первой буквы
  // спрашивать нечего.
  it('до первой буквы результатов нет', async () => {
    await renderSearch()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
    })
    expect(screen.queryByText('Анкета читателя')).toBeNull()
    expect(screen.getByText(/Начните набирать название/)).toBeTruthy()
  })
})
