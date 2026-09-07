// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
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

import { type ScheduleListItem } from '../../entities/schedule'
import { ScheduleRow } from './ScheduleRow'

afterEach(cleanup)

const BASE: ScheduleListItem = {
  id: 's-1',
  workspaceId: 'w-1',
  name: 'Мария — рисование',
  timezone: 'Europe/Moscow',
  availability: {
    weekly: {
      mon: [{ from: '10:00', to: '18:00' }],
      tue: [{ from: '10:00', to: '18:00' }],
    },
    exceptions: [],
  },
  slotMinutes: 60,
  bufferMinutes: 0,
  horizonDays: 30,
  leadMinutes: 120,
  capacity: 1,
  maxSeatsPerBooking: 1,
  showRemaining: false,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-05T10:00:00Z',
  formsCount: 2,
  upcomingCount: 3,
  nextBookingAt: '2026-09-09T07:00:00Z',
}

async function renderRow(schedule: Partial<ScheduleListItem>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <ScheduleRow schedule={{ ...BASE, ...schedule }} workspaceSlug="team" />
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/w/$workspaceSlug/schedules/$scheduleId',
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
}

describe('строка списка расписаний', () => {
  it('ведёт на страницу своего расписания', async () => {
    await renderRow({})
    const link = screen.getByRole('link', { name: 'Мария — рисование' })
    expect(link.getAttribute('href')).toBe('/w/team/schedules/s-1')
  })

  // Ближайшая запись — в поясе РАСПИСАНИЯ. 07:00 UTC у московского расписания это
  // 10:00; прочитай строка пояс браузера, число поехало бы вместе с ним.
  it('ближайшую запись показывает в поясе расписания', async () => {
    await renderRow({})
    // Ищется именно колонка «Ближайшая»: «10:00» есть и в часах недели
    // (10:00–18:00), и совпадение по одному числу ничего бы не доказало.
    expect(screen.getByText('9 сент., 10:00')).toBeTruthy()
  })

  // «Впереди пусто» и «ноль» — разные новости: нолями строка читалась бы как
  // расписание, которое все проигнорировали, а его просто ещё никто не открывал.
  it('при пустом будущем ставит прочерки вместо нулей', async () => {
    await renderRow({ upcomingCount: 0, nextBookingAt: null })
    expect(screen.getAllByText('—').length).toBe(2)
  })

  // Пустое недельное правило означает, что записаться нельзя ни в один день, —
  // состояние, о котором иначе не узнать, не открыв расписание.
  it('расписание без часов приёма помечено, и сводка не повторяет метку', async () => {
    await renderRow({ availability: { weekly: {}, exceptions: [] } })
    expect(screen.getByText('приём не ведётся')).toBeTruthy()
    expect(screen.queryByText(/Приём не ведётся/)).toBeNull()
  })

  it('расписание с часами приёма метку не показывает, а часы показывает', async () => {
    await renderRow({})
    expect(screen.queryByText('приём не ведётся')).toBeNull()
    expect(screen.getByText(/пн–вт, 10:00–18:00/)).toBeTruthy()
  })

  // Расписание без единой формы наружу не выходит: записаться в него неоткуда, и
  // ноль в колонке «Формы» эту новость не доносит.
  it('расписание без форм помечено словами', async () => {
    await renderRow({ formsCount: 0 })
    expect(screen.getByText('не подключено к форме')).toBeTruthy()

    cleanup()
    await renderRow({ formsCount: 1 })
    expect(screen.queryByText('не подключено к форме')).toBeNull()
  })

  // Действия видны ВСЕГДА, а не по наведению: на тач-экране наведения не наступает
  // никогда, и спрятанное под него действие недоступно совсем.
  it('меню действий стоит в строке и названо расписанием', async () => {
    await renderRow({})
    expect(
      screen.getByRole('button', { name: 'Действия с расписанием «Мария — рисование»' }),
    ).toBeTruthy()
  })
})
