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
const deleteNotification = vi.fn<(id: string) => Promise<void>>()
const deleteAllNotifications = vi.fn<() => Promise<void>>()

vi.mock('./api', () => ({
  listNotifications: () => listNotifications(),
  markNotificationsRead: (body: unknown) => markNotificationsRead(body),
  deleteNotification: (id: string) => deleteNotification(id),
  deleteAllNotifications: () => deleteAllNotifications(),
}))

afterEach(() => {
  cleanup()
  listNotifications.mockReset()
  markNotificationsRead.mockReset()
  deleteNotification.mockReset()
  deleteAllNotifications.mockReset()
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
  deleteNotification.mockResolvedValue(undefined)
  deleteAllNotifications.mockResolvedValue(undefined)
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
// Радиксовое МЕНЮ, в отличие от шторки, открывается Enter'ом на триггере (грабли
// дизайн-системы).
async function openRowMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Действия с уведомлением' }), {
    key: 'Enter',
  })
  await act(async () => {})
}

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

  // Крестик нужен именно в панели: промах мимо шторки попадает в соседнюю строку
  // меню, и вместо закрытия человек уходит в «Тариф».
  it('крестик закрывает шторку', async () => {
    await renderBell({ items: [row()], unread: 1 })
    await openBell()
    expect(screen.getByRole('link', { name: /Заявка — 3 новых ответа/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    await act(async () => {})
    expect(screen.queryByRole('link', { name: /Заявка — 3 новых ответа/ })).toBeNull()
  })

  // Действия строки живут в «⋯» — так же, как у строки списка форм: строка
  // нажимается целиком, и разрушающее действие обязано называться словом, а не
  // значком внутри нажимаемой области.
  it('«Удалить» из меню строки удаляет её и не отмечает прочтением', async () => {
    await renderBell({ items: [row()], unread: 1 })
    await openBell()
    await openRowMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }))
    await act(async () => {})
    expect(deleteNotification).toHaveBeenCalledWith('n-1')
    expect(markNotificationsRead).not.toHaveBeenCalled()
  })

  // Прочесть, не уходя по ссылке: нажатие на строку уводит со шторки, а повод
  // бывает понятен и без перехода.
  it('«Отметить прочитанным» гасит одну строку', async () => {
    await renderBell({ items: [row()], unread: 1 })
    await openBell()
    await openRowMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Отметить прочитанным' }))
    await act(async () => {})
    expect(markNotificationsRead).toHaveBeenCalledWith({ ids: ['n-1'] })
  })

  // У прочитанной строки этого пункта нет: он ничего не сделал бы.
  it('у прочитанной строки в меню только удаление', async () => {
    await renderBell({ items: [row({ read: true })], unread: 0 })
    await openBell()
    await openRowMenu()
    expect(screen.queryByRole('menuitem', { name: 'Отметить прочитанным' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Удалить' })).toBeTruthy()
  })

  it('«Удалить все» чистит ленту целиком', async () => {
    await renderBell({ items: [row(), row({ id: 'n-2' })], unread: 2 })
    await openBell()
    fireEvent.click(screen.getByRole('button', { name: 'Удалить все' }))
    await act(async () => {})
    expect(deleteAllNotifications).toHaveBeenCalled()
  })

  // Пустой ленте нечего удалять, и кнопка, которая ничего не делает, — обещание
  // впустую.
  it('у пустой ленты нет ни «Прочитать всё», ни «Удалить все»', async () => {
    await renderBell({ items: [], unread: 0 })
    await openBell()
    expect(screen.queryByRole('button', { name: 'Удалить все' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Прочитать всё' })).toBeNull()
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
