// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router'

import { periodSchema } from '../../shared/period'

afterEach(cleanup)

// РЕГРЕССИЯ. Селектор периода живёт на ОБОЛОЧКЕ раздела «Аналитика», а вкладки —
// её дети. Переход, сделанный маршрутным navigate (Route.useNavigate) без `to`,
// базой берёт САМ МАРШРУТ, то есть оболочку: адрес уходил на /insights, его index
// редиректил на «Сводку», и смена периода на вкладке «Визиты» выбрасывала человека
// на другую вкладку.
//
// Здесь собран тот же скелет маршрутов в памяти: оболочка с периодом и две вкладки.
// Индекса с редиректом в скелете нет — он лишь усугублял симптом (выбрасывал на
// «Сводку»); сам дефект в том, что адрес уходил с вкладки на оболочку, и это тест и
// ловит.
function renderInsights(initial: string) {
  const rootRoute = createRootRoute()

  const insights = createRoute({
    getParentRoute: () => rootRoute,
    path: '/insights',
    validateSearch: (search: Record<string, unknown>) => ({
      period: periodSchema.parse(search.period),
    }),
    component: PeriodSwitcher,
  })

  const answers = createRoute({
    getParentRoute: () => insights,
    path: '/answers',
    component: () => <span data-testid="tab">answers</span>,
  })

  const visits = createRoute({
    getParentRoute: () => insights,
    path: '/visits',
    component: () => <span data-testid="tab">visits</span>,
  })

  const router = createRouter({
    routeTree: rootRoute.addChildren([insights.addChildren([answers, visits])]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })

  render(<RouterProvider router={router as never} />)
  return router
}

// PeriodSwitcher повторяет то, что делает настоящий селектор: тот же вызов navigate.
// Radix Select в happy-dom не открывается вовсе (web/CLAUDE.md), поэтому здесь
// кнопка — предмет проверки не в контроле, а в переходе.
function PeriodSwitcher() {
  const navigate = useNavigate()
  return (
    <>
      <button
        onClick={() =>
          void navigate({ to: '.', search: (prev) => ({ ...prev, period: '30d' as const }) })
        }
      >
        30 дней
      </button>
      <Outlet />
    </>
  )
}

describe('смена периода в разделе «Аналитика»', () => {
  it('оставляет открытой ту же вкладку', async () => {
    const router = renderInsights('/insights/visits?period=24h')
    await act(async () => {
      await router.load()
    })
    expect(screen.getByTestId('tab').textContent).toBe('visits')

    await act(async () => {
      screen.getByText('30 дней').click()
    })

    // До починки здесь было '/insights': маршрутный navigate без `to` уводил на
    // оболочку, а в живом приложении её index редиректил дальше, на «Сводку».
    expect(router.state.location.pathname).toBe('/insights/visits')
    expect(router.state.location.search).toEqual({ period: '30d' })
    expect(screen.getByTestId('tab').textContent).toBe('visits')
  })
})
