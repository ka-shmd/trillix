// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  frozen: false,
}
const TEAM = {
  id: 'ws-team',
  slug: 'team',
  name: 'Команда',
  isPersonal: false,
  formCount: 7,
  frozen: false,
}

// Панель — навигация по РАЗДЕЛАМ ТЕКУЩЕГО пространства, и предмет проверки один:
// адрес каждого пункта называет то пространство, в котором человек стоит. Пока
// разделы жили в верхнем ярусе, пункт пространства не называл, и раздел молча
// открывался в личном (спека docs/design/cabinet-navigation.md §2).
async function renderNav(initial: string, permissions?: string[], frozenTeam = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(workspaceKeys.list(), [PERSONAL, { ...TEAM, frozen: frozenTeam }])
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

// Список пространств живёт в выпадающем меню и до открытия не отрисован; строка
// в нём — `menuitem`, а не `link`, хотя внутри ссылка (Radix ставит свою роль).
async function switchHref(name: string) {
  const trigger = screen.getByRole('button', { name: /Личное пространство|Команда/ })
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  })
  return screen.getByRole('menuitem', { name }).getAttribute('href')
}

describe('навигация пространства в сайдбаре', () => {
  it('разделы ведут в пространство из адреса, а не в личное', async () => {
    await renderNav('/w/team/forms', ['billing.view'])
    expect(href('Формы')).toBe('/w/team/forms')
    expect(href('Расписания')).toBe('/w/team/schedules')
    expect(href('Участники')).toBe('/w/team/members')
  })

  // Тариф принадлежит АККАУНТУ (ADR §10, 2026-09-06): один план накрывает все
  // пространства человека, и разделом пространства пункт обещал бы обратное. Его
  // место — личный ярус подвала панели (`AppSidebar`).
  it('«Тариф» разделом пространства не стоит', async () => {
    await renderNav('/w/team/forms', ['billing.view'])
    expect(screen.queryByRole('link', { name: 'Тариф' })).toBeNull()
  })

  // Обзор пространств сам ничьим разделом не является; пока ничего не названо и
  // память пуста, отвечает личное.
  it('на экране без пространства разделы ведут в личное', async () => {
    await renderNav('/workspaces', ['billing.view'])
    expect(href('Формы')).toBe('/w/personal/forms')
  })

  // Шаблоны — свой раздел пространства (решение владельца 2026-09-07), и адрес у
  // него пространственный: форма из шаблона ложится туда, куда указывает путь.
  // Подсвечен ровно один пункт — иначе панель говорит, что человек в двух местах.
  it('в галерее шаблонов подсвечены «Шаблоны», а не «Формы»', async () => {
    await renderNav('/w/team/templates', ['billing.view'])
    expect(screen.getByRole('link', { name: 'Шаблоны' }).dataset.active).toBe('true')
    expect(screen.getByRole('link', { name: 'Формы' }).dataset.active).not.toBe('true')
  })

  it('«Шаблоны» ведут в галерею ТЕКУЩЕГО пространства', async () => {
    await renderNav('/w/team/forms', ['billing.view'])
    expect(href('Шаблоны')).toBe('/w/team/templates')
  })

  // СТОРОЖ ВЕНДОРЕННОЙ ПРАВКИ. У shadcn выбранный пункт красится тем же
  // `sidebar-accent`, что и наведение: подложка давала 1.045:1 к фону панели, а выбор
  // от наведения отличался только весом шрифта — то есть панель не отвечала, на какой
  // человек странице. Переустановка компонента из shadcn вернёт дефолт молча, и
  // заметить это можно только здесь: класс на элементе есть в обоих случаях, разный у
  // них токен.
  it('выбранный раздел красится акцентом, а не подложкой наведения', async () => {
    await renderNav('/w/team/schedules', ['billing.view'])
    const active = screen.getByRole('link', { name: 'Расписания' })
    expect(active.dataset.active).toBe('true')
    expect(active.className).toContain('data-[active=true]:bg-sidebar-primary-soft')
    expect(active.className).toContain('data-[active=true]:text-sidebar-primary-ink')
    expect(active.className).not.toContain('data-[active=true]:bg-sidebar-accent')
  })

  // СТОРОЖ ВЕНДОРЕННОЙ ПРАВКИ. У `Separator` ширина задана под атрибутным селектором
  // (`data-[orientation=horizontal]:w-full`), и плоский `w-auto` из `SidebarSeparator`
  // её не перебивал: у разных модификаторов разные ключи, `cn` оставлял оба класса, а
  // побеждал более специфичный. Вместе с `mx-2` это давало 100% + 16px и
  // горизонтальную прокрутку панели (отчёт владельца 2026-09-06).
  it('разделители не шире панели', async () => {
    await renderNav('/w/team/forms', ['billing.view'])
    const rules = document.querySelectorAll('[data-slot="sidebar-separator"]')
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.className).not.toContain('data-[orientation=horizontal]:w-full')
      expect(rule.className).toContain('data-[orientation=horizontal]:w-auto')
    }
  })

  // Замороженное пространство обязано объяснять себя ДО входа: без пометки оно
  // выглядит обычным, а каждый его экран отвечает 402 — то есть единственное
  // состояние продукта, из которого человек не может выйти сам, было неотличимо от
  // сетевого сбоя.
  it('закрытое пространство названо закрытым, а не командным', async () => {
    await renderNav('/w/team/forms', ['billing.view'], true)
    expect(screen.getByText('Закрыто — тариф')).toBeTruthy()
    expect(screen.queryByText('Командное')).toBeNull()
  })

  // Переключатель ведёт в ТОТ ЖЕ раздел, а не всегда в формы (отчёт владельца
  // 2026-09-07): человек нажимает его, поняв, что стоит не в том пространстве, —
  // и раздел при этом менять не собирался.
  it('переключение пространства оставляет человека в том же разделе', async () => {
    await renderNav('/w/personal/schedules', ['billing.view'])
    expect(await switchHref('Команда')).toBe('/w/team/schedules')
  })

  // Предмет раздела в соседнем пространстве не существует: перенос
  // идентификатора дал бы «нет такого» вместо списка.
  it('со страницы расписания переключатель ведёт в список расписаний', async () => {
    await renderNav('/w/personal/schedules/sch-1', ['billing.view'])
    expect(await switchHref('Команда')).toBe('/w/team/schedules')
  })

  // Настройки и обзор пространств разделом пространства не являются — отвечают
  // формами, тем же, чем переключатель отвечал всегда.
  it('вне пространства переключатель ведёт в формы', async () => {
    await renderNav('/workspaces', ['billing.view'])
    expect(await switchHref('Команда')).toBe('/w/team/forms')
  })

  // Переключатель обязан читаться местом, а не пятым пунктом списка: буква
  // пространства и подпись, чем оно является.
  it('переключатель называет пространство буквой и видом', async () => {
    await renderNav('/w/team/forms', ['billing.view'])
    expect(screen.getByText('К')).toBeTruthy()
    expect(screen.getByText('Командное')).toBeTruthy()

    cleanup()
    await renderNav('/w/personal/forms', ['billing.view'])
    expect(screen.getByText('Личное')).toBeTruthy()
  })
})
