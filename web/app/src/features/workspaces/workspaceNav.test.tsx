// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import { WorkspaceAddressProvider } from '../../shared/workspaceContext'
import { SidebarProvider } from '@/components/ui/sidebar'
import { WorkspaceNav } from './WorkspaceNav'
import { workspaceKeys } from './keys'

afterEach(cleanup)
// Память оболочки переживает переход между экранами намеренно, но не должна
// переживать переход между ТЕСТАМИ: в happy-dom хранилище одно на файл.
beforeEach(() => window.localStorage.clear())

const PERSONAL = {
  id: 'ws-personal',
  slug: 'personal',
  name: 'Личное пространство',
  isPersonal: true,
  formCount: 3,
}
const TEAM = { id: 'ws-team', slug: 'team', name: 'Команда', isPersonal: false, formCount: 7 }

// Панель — навигация по РАЗДЕЛАМ ТЕКУЩЕГО пространства, и предмет проверки один:
// адрес каждого пункта называет то пространство, в котором человек стоит. Пока
// разделы жили в верхнем ярусе, пункт пространства не называл, и раздел молча
// открывался в личном (спека docs/design/cabinet-navigation.md §2).
async function renderNav(initial: string, permissions?: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(workspaceKeys.list(), [PERSONAL, TEAM])
  if (permissions) {
    qc.setQueryData(workspaceKeys.members(TEAM.id), { members: [], invites: [], permissions })
    qc.setQueryData(workspaceKeys.members(PERSONAL.id), { members: [], invites: [], permissions })
  }

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <WorkspaceAddressProvider personalSlug={PERSONAL.slug}>
          <SidebarProvider>
            <WorkspaceNav />
            <Outlet />
          </SidebarProvider>
        </WorkspaceAddressProvider>
      </QueryClientProvider>
    ),
  })
  const paths = [
    '/w/$workspaceSlug/forms',
    '/w/$workspaceSlug/schedules',
    '/w/$workspaceSlug/members',
    '/w/$workspaceSlug/plan',
    '/w/$workspaceSlug/templates',
    '/workspaces',
  ]
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      paths.map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
}

const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href')

describe('навигация пространства в сайдбаре', () => {
  it('разделы ведут в пространство из адреса, а не в личное', async () => {
    await renderNav('/w/team/forms', ['billing.view'])
    expect(href('Формы')).toBe('/w/team/forms')
    expect(href('Расписания')).toBe('/w/team/schedules')
    expect(href('Участники')).toBe('/w/team/members')
    expect(href('Тариф')).toBe('/w/team/plan')
  })

  // Обзор пространств сам ничьим разделом не является; пока ничего не названо и
  // память пуста, отвечает личное.
  it('на экране без пространства разделы ведут в личное', async () => {
    await renderNav('/workspaces', ['billing.view'])
    expect(href('Формы')).toBe('/w/personal/forms')
  })

  // Право `billing.view` есть только у владельца: редактор получил бы 403, и пункт,
  // который заведомо откажет, стоять в панели не должен.
  it('редактор пункта «Тариф» не видит', async () => {
    await renderNav('/w/team/forms', ['form.read', 'member.read'])
    expect(screen.queryByRole('link', { name: 'Тариф' })).toBeNull()
  })

  // ПОКА НЕ ЗНАЕМ — ПОКАЗЫВАЕМ: пункт, мигнувший и пропавший у владельца, стоит
  // дороже лишнего пункта у редактора, а настоящий отказ всё равно на бэке.
  it('права ещё не приехали — «Тариф» на месте', async () => {
    await renderNav('/w/team/forms')
    expect(href('Тариф')).toBe('/w/team/plan')
  })

  it('галерея шаблонов — часть работы с формами, и подсвечены «Формы»', async () => {
    await renderNav('/w/team/templates', ['billing.view'])
    expect(screen.getByRole('link', { name: 'Формы' }).dataset.active).toBe('true')
  })
})
