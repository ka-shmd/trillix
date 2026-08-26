// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router'

import { periodSchema, withoutPeriod } from '../../shared/period'

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

// РЕГРЕССИЯ. Ряд разделов формы («Поделиться · Аналитика · Ответы · Интеграции»)
// и вкладки внутри «Аналитики» — ссылки роутера, а активную подсветку им ставит
// `activeProps`. Роутер считает ссылку активной, только если её search — ПОДМНОЖЕСТВО
// текущего (`deepEqual(..., { partial: true })` в link.js), поэтому ссылка, у которой
// период вбит константой, гаснет на любом другом периоде.
//
// Здесь скелет повторяет ссылки `routes/_app/forms.$slug._manage.tsx` и оболочки
// `insights.tsx` по единственному свойству, из-за которого дефект и случился, — по
// `search`. Подсветка проверяется data-атрибутом, а не настоящими классами: предмет
// проверки — что роутер СЧИТАЕТ ссылку активной, а не какого она цвета.
function renderSections(initial: string, analyticsSearch: 'pinned' | 'inherited') {
  const rootRoute = createRootRoute()

  const form = createRoute({
    getParentRoute: () => rootRoute,
    path: '/forms/$slug',
    component: () => {
      const { slug } = form.useParams()
      return (
        <>
          <Link
            to="/forms/$slug/share"
            params={{ slug }}
            search={withoutPeriod}
            activeProps={{ 'data-on': 'yes' }}
          >
            Поделиться
          </Link>
          <Link
            to="/forms/$slug/insights"
            params={{ slug }}
            search={
              analyticsSearch === 'pinned'
                ? { period: '24h' as const }
                : (prev) => ({ ...prev, period: periodSchema.parse(prev.period) })
            }
            activeProps={{ 'data-on': 'yes' }}
          >
            Аналитика
          </Link>
          <Outlet />
        </>
      )
    },
  })

  const share = createRoute({
    getParentRoute: () => form,
    path: '/share',
    component: () => <span data-testid="tab">share</span>,
  })

  const insights = createRoute({
    getParentRoute: () => form,
    path: '/insights',
    validateSearch: (search: Record<string, unknown>) => ({
      period: periodSchema.parse(search.period),
    }),
    component: InsightsShell,
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
    routeTree: rootRoute.addChildren([
      form.addChildren([share, insights.addChildren([answers, visits])]),
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })

  render(<RouterProvider router={router as never} />)
  return router
}

// Оболочка раздела: кнопка периода — тот же переход, что делает настоящий селектор,
// вкладка — та же ссылка, что рисует InsightsTabs. Адреса взяты НАСТОЯЩИЕ
// (/forms/$slug/insights/…): `Link` типизирован по сгенерированному дереву маршрутов
// приложения, и выдуманный путь в него не проходит.
function InsightsShell() {
  const navigate = useNavigate()
  const { slug } = useParams({ strict: false })
  const search = useSearch({ strict: false })

  return (
    <>
      <button
        onClick={() =>
          void navigate({ to: '.', search: (prev) => ({ ...prev, period: '30d' as const }) })
        }
      >
        30 дней
      </button>
      <Link
        to="/forms/$slug/insights/visits"
        params={{ slug: slug ?? '' }}
        search={() => ({ ...search, period: periodSchema.parse(search.period) })}
      >
        Визиты
      </Link>
      <Outlet />
    </>
  )
}

describe('подсветка раздела «Аналитика»', () => {
  it('переживает смену периода', async () => {
    renderSections('/forms/abc/insights/answers?period=24h', 'inherited')
    await act(async () => {})
    expect(screen.getByText('Аналитика').getAttribute('data-on')).toBe('yes')

    await act(async () => {
      screen.getByText('30 дней').click()
    })

    // До починки здесь было null: ссылка несла `search={{ period: DEFAULT_PERIOD }}`,
    // и на периоде «30 дней» её search переставал быть подмножеством текущего.
    expect(screen.getByText('Аналитика').getAttribute('data-on')).toBe('yes')
  })

  // Обратная сторона той же проверки: она показывает, что первая краснеет без
  // починки, и заодно объясняет, почему константы в `search` ссылки быть не может.
  // `?w=` называет пространство (shared/currentWorkspace.ts) и никакому маршруту
  // аналитики не принадлежит — он просто едет рядом. Вкладка, собирающая search
  // заново, увозила бы человека в ЛИЧНОЕ пространство: крошка и гейты тарифа
  // спрашивали бы не тот план, а сам переход выглядел бы обычным.
  it('переносит чужие параметры адреса на соседнюю вкладку', async () => {
    const router = renderSections('/forms/abc/insights/answers?w=ws-1&period=7d', 'inherited')
    await act(async () => {
      await router.load()
    })

    await act(async () => {
      screen.getByText('Визиты').click()
    })

    expect(router.state.location.pathname).toBe('/forms/abc/insights/visits')
    expect(router.state.location.search).toEqual({ w: 'ws-1', period: '7d' })
  })

  // Окно наблюдения — параметр раздела, а не формы. Ссылка «(prev) => prev», которой
  // разделы переносят пространство и поиск дашборда, тянула его наружу: `?period=30d`
  // доезжал до списка форм и оставался в адресе, которым человек делится.
  it('снимает окно наблюдения на выходе из раздела', async () => {
    const router = renderSections('/forms/abc/insights/answers?w=ws-1&period=30d', 'inherited')
    await act(async () => {
      await router.load()
    })

    await act(async () => {
      screen.getByText('Поделиться').click()
    })

    expect(router.state.location.pathname).toBe('/forms/abc/share')
    expect(router.state.location.search).toEqual({ w: 'ws-1' })
  })

  it('вбитый в ссылку период гасит её на любом другом', async () => {
    renderSections('/forms/abc/insights/answers?period=30d', 'pinned')
    await act(async () => {})
    expect(screen.getByText('Аналитика').getAttribute('data-on')).toBe(null)
  })
})
