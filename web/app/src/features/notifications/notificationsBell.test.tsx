// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
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

import type { Notification, NotificationFeed } from '../../entities/notification'
import { SidebarMenu, SidebarProvider } from '@/components/ui/sidebar'

import { groupByWorkspace } from './grouping'
import { NotificationsBell } from './NotificationsBell'

const listNotifications = vi.fn<() => Promise<NotificationFeed>>()
const markNotificationsRead = vi.fn<(body: unknown) => Promise<void>>()

vi.mock('./api', () => ({
  listNotifications: () => listNotifications(),
  markNotificationsRead: (body: unknown) => markNotificationsRead(body),
}))

afterEach(() => {
  cleanup()
  listNotifications.mockReset()
  markNotificationsRead.mockReset()
})

function row(over: Partial<Notification> = {}): Notification {
  return {
    id: 'n-1',
    workspaceId: 'ws-1',
    workspaceName: 'Личное',
    workspaceSlug: 'personal',
    kind: 'new_submissions',
    text: 'Заявка — 3 новых ответа',
    link: '/forms/zayavka/submissions',
    count: 3,
    firstAt: '2026-09-13T10:00:00Z',
    lastAt: '2026-09-13T12:00:00Z',
    read: false,
    ...over,
  }
}

async function renderBell(feed: NotificationFeed) {
  listNotifications.mockResolvedValue(feed)
  markNotificationsRead.mockResolvedValue(undefined)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        {/* Пункт живёт строкой меню сайдбара, поэтому и в тесте он внутри панели:
          `SidebarMenuButton` спрашивает состояние панели (свёрнута ли) ради
          подсказки. */}
        <SidebarProvider>
          <SidebarMenu>
            <NotificationsBell />
          </SidebarMenu>
        </SidebarProvider>
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/forms/$slug/submissions', '/forms/$slug/integrations', '/w/$workspaceSlug/plan'].map(
        (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
  // Лента приезжает запросом уже после монтирования: без этого прогона обещаний
  // компонент виден в первом кадре, где непрочитанных ещё ноль.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

// Радиксовый триггер в тестах открывается Enter'ом, а не кликом (грабли
// дизайн-системы).
async function openBell() {
  // Радиксовый триггер открывается указателем: в happy-dom это pointerDown, а не
  // click — на голый click он не реагирует вовсе.
  const trigger = screen.getByRole('button', { name: /Уведомления/ })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(trigger)
  await act(async () => {})
}

describe('группировка ленты', () => {
  // Порядок ленты несущий: сверху то, где случилось последнее. Сортировка групп по
  // имени увела бы «Личное» вниз ровно тогда, когда туда и надо смотреть.
  it('сохраняет порядок и собирает строки одного пространства вместе', () => {
    const groups = groupByWorkspace([
      row({ id: 'a', workspaceId: 'ws-2', workspaceName: 'Команда' }),
      row({ id: 'b', workspaceId: 'ws-1' }),
      row({ id: 'c', workspaceId: 'ws-2', workspaceName: 'Команда' }),
    ])
    expect(groups.map((g) => g.id)).toEqual(['ws-2', 'ws-1'])
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'c'])
  })
})

describe('колокольчик', () => {
  it('непрочитанные помечены точкой и названы в имени кнопки', async () => {
    await renderBell({ items: [row()], unread: 1 })
    expect(screen.getByRole('button', { name: 'Уведомления: непрочитанных 1' })).toBeTruthy()
  })

  // Число видно сразу, не открывая шторку: в панели для него есть место, и «сколько
  // именно» — первое, что спрашивают. Трёхзначное жмётся, чтобы не рвать строку.
  it('показывает число непрочитанных значком', async () => {
    await renderBell({ items: [row()], unread: 7 })
    expect(screen.getByText('7')).toBeTruthy()
    cleanup()

    await renderBell({ items: [row()], unread: 140 })
    expect(screen.getByText('99+')).toBeTruthy()
  })

  it('без непрочитанных кнопка не обещает нового', async () => {
    await renderBell({ items: [row({ read: true })], unread: 0 })
    expect(screen.getByRole('button', { name: 'Уведомления' })).toBeTruthy()
  })

  // Текст и адрес строки приходят с сервера: реестр поводов — единственное место,
  // где повод описан, и экран его не пересказывает.
  it('показывает текст и ссылку, пришедшие с сервера', async () => {
    await renderBell({ items: [row()], unread: 1 })
    await openBell()
    const link = screen.getByRole('link', { name: /Заявка — 3 новых ответа/ })
    expect(link.getAttribute('href')).toBe('/forms/zayavka/submissions')
  })

  it('пустая лента говорит об этом словами', async () => {
    await renderBell({ items: [], unread: 0 })
    await openBell()
    expect(screen.getByText('Пока ничего не произошло.')).toBeTruthy()
  })

  it('«Прочитать всё» гасит ленту целиком', async () => {
    await renderBell({ items: [row()], unread: 1 })
    await openBell()
    fireEvent.click(screen.getByRole('button', { name: 'Прочитать всё' }))
    await act(async () => {})
    expect(markNotificationsRead).toHaveBeenCalledWith({ all: true })
  })

  // Переход по строке — то же прочтение: человек пришёл туда, куда повод звал.
  it('нажатие на строку отмечает её прочитанной', async () => {
    await renderBell({ items: [row()], unread: 1 })
    await openBell()
    fireEvent.click(screen.getByRole('link', { name: /Заявка — 3 новых ответа/ }))
    await act(async () => {})
    expect(markNotificationsRead).toHaveBeenCalledWith({ ids: ['n-1'] })
  })

  it('прочитанную строку повторно не отмечает', async () => {
    await renderBell({ items: [row({ read: true })], unread: 0 })
    await openBell()
    fireEvent.click(screen.getByRole('link', { name: /Заявка — 3 новых ответа/ }))
    await act(async () => {})
    expect(markNotificationsRead).not.toHaveBeenCalled()
  })

  // Заголовок пространства — только когда их несколько: у человека с одним личным
  // он повторял бы одно и то же над каждой строкой.
  it('называет пространство, когда их больше одного', async () => {
    await renderBell({ items: [row()], unread: 1 })
    await openBell()
    expect(screen.queryByText('Личное')).toBeNull()
    cleanup()

    await renderBell({
      items: [row(), row({ id: 'n-2', workspaceId: 'ws-2', workspaceName: 'Команда' })],
      unread: 2,
    })
    await openBell()
    expect(screen.getByText('Личное')).toBeTruthy()
    expect(screen.getByText('Команда')).toBeTruthy()
  })
})
