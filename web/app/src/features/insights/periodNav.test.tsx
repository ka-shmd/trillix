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

import { periodSchema } from '../../shared/period'

afterEach(cleanup)

// РЕГРЕССИЯ. Селектор периода живёт на ОБОЛОЧКЕ раздела «Аналитика», а вкладки —
// её дети. Переход, сделанный маршрутным navigate (Route.useNavigate) без `to`,
// базой берёт САМ МАРШРУТ, то есть оболочку: адрес уходил на /insights, и смена
// периода на вкладке «Визиты» выбрасывала человека на другую вкладку.
//
// Симптом с фазы 30 стал хуже, а не лучше: раньше index раздела редиректил на
// «Сводку», теперь на /insights стоит собственный экран «Обзор» — уехать туда с
// «Визитов» по-прежнему неверно.
//
// Здесь собран тот же скелет маршрутов в памяти: оболочка с периодом и две вкладки.
// Индекса в скелете нет — он лишь усугубляет симптом; сам дефект в том, что адрес
// уходил с вкладки на оболочку, и это тест и ловит.
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

// PeriodSwitcher повторяет то, что делает настоящий переключатель периода: тот же
// вызов navigate с той же кнопки. Предмет проверки — переход, а не контрол.
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
          <Link to="/forms/$slug/share" params={{ slug }} activeProps={{ 'data-on': 'yes' }}>
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
    const router = renderSections('/forms/abc/insights/answers?period=7d', 'inherited')
    await act(async () => {
      await router.load()
    })

    await act(async () => {
      screen.getByText('Визиты').click()
    })

    expect(router.state.location.pathname).toBe('/forms/abc/insights/visits')
    expect(router.state.location.search).toEqual({ period: '7d' })
  })

  // Окно наблюдения — параметр РАЗДЕЛА, а не формы: за его пределами он не значит
  // ничего и не должен оставаться в адресе, которым человек делится. Пока ссылки
  // кабинета переносили search целиком (в нём ехало пространство, `?w=`), период
  // тянулся наружу вместе с ним и доезжал до списка форм. Пространство переехало в
  // путь, переносить стало нечего — и ссылка наружу теперь не несёт ничего.
  it('снимает окно наблюдения на выходе из раздела', async () => {
    const router = renderSections('/forms/abc/insights/answers?period=30d', 'inherited')
    await act(async () => {
      await router.load()
    })

    await act(async () => {
      screen.getByText('Поделиться').click()
    })

    expect(router.state.location.pathname).toBe('/forms/abc/share')
    expect(router.state.location.search).toEqual({})
  })

  it('вбитый в ссылку период гасит её на любом другом', async () => {
    renderSections('/forms/abc/insights/answers?period=30d', 'pinned')
    await act(async () => {})
    expect(screen.getByText('Аналитика').getAttribute('data-on')).toBe(null)
  })
})

// Вкладка «Обзор» стоит на INDEX-маршруте раздела (фаза 30, редизайн), поэтому её
// адрес — префикс адресов «Визитов» и «Ответов». Роутер по умолчанию считает ссылку
// активной и на потомках (`activeOptions.exact` по умолчанию false), и без явного
// exact подсвеченными оказывались бы ДВЕ вкладки сразу — «Обзор» и та, что открыта.
//
// Дефект молчаливый: классы на ссылке есть, маршрут верный, экран верный, просто
// сегментированный переключатель показывает два выбранных сегмента. Поэтому тест
// проверяет обе стороны: «Обзор» гаснет на соседе и горит у себя.
// Ряд вкладок раздела: те же две ссылки, что рисует InsightsTabs, и то же
// единственное свойство, из-за которого дефект возможен, — activeOptions у «Обзора».
function OverviewTabs() {
  const { slug } = useParams({ strict: false })

  return (
    <>
      <Link
        to="/forms/$slug/insights"
        params={{ slug: slug ?? '' }}
        search={(prev) => ({ ...prev, period: periodSchema.parse(prev.period) })}
        activeOptions={{ exact: true }}
        activeProps={{ 'data-on': 'yes' }}
      >
        Обзор
      </Link>
      <Link
        to="/forms/$slug/insights/visits"
        params={{ slug: slug ?? '' }}
        search={(prev) => ({ ...prev, period: periodSchema.parse(prev.period) })}
        activeProps={{ 'data-on': 'yes' }}
      >
        Визиты
      </Link>
      <Outlet />
    </>
  )
}

function renderOverviewTabs(initial: string) {
  const rootRoute = createRootRoute()

  const insights = createRoute({
    getParentRoute: () => rootRoute,
    path: '/forms/$slug/insights',
    validateSearch: (search: Record<string, unknown>) => ({
      period: periodSchema.parse(search.period),
    }),
    component: OverviewTabs,
  })

  const overview = createRoute({
    getParentRoute: () => insights,
    path: '/',
    component: () => <span data-testid="tab">overview</span>,
  })

  const visits = createRoute({
    getParentRoute: () => insights,
    path: '/visits',
    component: () => <span data-testid="tab">visits</span>,
  })

  const router = createRouter({
    routeTree: rootRoute.addChildren([insights.addChildren([overview, visits])]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })

  render(<RouterProvider router={router as never} />)
  return router
}

describe('вкладка «Обзор» на index раздела', () => {
  it('горит на своём адресе', async () => {
    renderOverviewTabs('/forms/abc/insights?period=7d')
    await act(async () => {})
    expect(screen.getByText('Обзор').getAttribute('data-on')).toBe('yes')
    expect(screen.getByText('Визиты').getAttribute('data-on')).toBe(null)
  })

  it('гаснет на соседней вкладке, хотя её адрес — префикс', async () => {
    renderOverviewTabs('/forms/abc/insights/visits?period=7d')
    await act(async () => {})
    // Без activeOptions.exact здесь было бы 'yes' — и оба сегмента выглядели бы
    // выбранными.
    expect(screen.getByText('Обзор').getAttribute('data-on')).toBe(null)
    expect(screen.getByText('Визиты').getAttribute('data-on')).toBe('yes')
  })
})
