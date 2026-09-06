// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import {
  useDeclareWorkspace,
  useWorkspaceAddress,
  WorkspaceAddressProvider,
} from './workspaceContext'

afterEach(cleanup)
beforeEach(() => window.localStorage.clear())

// Предмет проверки — ПОРЯДОК ИСТОЧНИКОВ: путь → заявление формы → память браузера →
// личное. Порядок и есть вся ценность модуля: перепутанный, он возвращает ровно тот
// дефект, ради которого пространство переехало в путь (см. спеку
// docs/design/cabinet-navigation.md §3.2) — экран показывает не то пространство, а
// создание кладёт форму не туда.
function Probe() {
  const { slug, named } = useWorkspaceAddress()
  return <span data-testid="probe">{`${slug}|${named ? 'named' : 'guessed'}`}</span>
}

// Экран формы: пространства в адресе нет, форма заявляет своё.
function FormScreen({ declares }: { declares: string | undefined }) {
  useDeclareWorkspace(declares)
  return <Probe />
}

async function renderAt(initial: string, declares: string | undefined, personalSlug = 'personal') {
  const rootRoute = createRootRoute({
    component: () => (
      <WorkspaceAddressProvider personalSlug={personalSlug}>
        <Outlet />
      </WorkspaceAddressProvider>
    ),
  })
  const wsForms = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$workspaceSlug/forms',
    component: () => <FormScreen declares={declares} />,
  })
  const formShare = createRoute({
    getParentRoute: () => rootRoute,
    path: '/forms/$slug/share',
    component: () => <FormScreen declares={declares} />,
  })
  const account = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/account',
    component: () => <Probe />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([wsForms, formShare, account]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
  return router
}

const read = () => screen.getByTestId('probe').textContent

describe('какое пространство считается текущим', () => {
  it('путь называет — он и отвечает', async () => {
    await renderAt('/w/ws-path/forms', undefined)
    expect(read()).toBe('ws-path|named')
  })

  // МИНА. Путь и форма разойтись не должны, но если разошлись, верить надо адресу:
  // на `/w/{ws}/forms/new/edit` формы ещё нет, и заявление пришло бы от предыдущей.
  it('путь важнее заявления формы', async () => {
    await renderAt('/w/ws-path/forms', 'ws-form')
    expect(read()).toBe('ws-path|named')
  })

  it('путь молчит — отвечает сама форма', async () => {
    await renderAt('/forms/abc/share', 'ws-form')
    expect(read()).toBe('ws-form|named')
  })

  // Ровно тот случай, ради которого заявление и заведено: прямая ссылка на форму
  // командного пространства из письма или закладки. До переезда адрес читался как
  // личное, и крошка с сайдбаром называли не то место (TD-69).
  it('форма ещё не приехала — не выдумываем, отступаем к личному', async () => {
    await renderAt('/forms/abc/share', undefined)
    expect(read()).toBe('personal|guessed')
  })

  it('экран без пространства помнит последнее НАЗВАННОЕ', async () => {
    const router = await renderAt('/w/ws-path/forms', undefined)
    await act(async () => {
      await router.navigate({ to: '/settings/account' })
    })
    // Названо оно больше не адресом, поэтому `named` — false: по подсказке памяти
    // ничего не создаётся, и вызывающий обязан это различать.
    expect(read()).toBe('ws-path|guessed')
  })

  // Сторож на «залипание»: память заполняется каждым названным пространством, и
  // источник, поставленный впереди адреса, показывал бы прошлое место на каждом
  // переходе между пространствами.
  it('переход в другое пространство не залипает на прошлом', async () => {
    const router = await renderAt('/w/ws-path/forms', undefined)
    await act(async () => {
      await router.navigate({
        to: '/w/$workspaceSlug/forms',
        params: { workspaceSlug: 'ws-other' },
      })
    })
    expect(read()).toBe('ws-other|named')
  })

  // Уход с формы СНИМАЕТ её заявление, и это не уборка ради уборки: пространство
  // остаётся тем же (его помнит оболочка), но перестаёт быть НАЗВАННЫМ. Разницу
  // читает `useCurrentWorkspace`: по названному и не найденному в списке действовать
  // нельзя, по подсказанному памятью — можно отступить к личному.
  it('уход с формы снимает её заявление, оставляя подсказку', async () => {
    const router = await renderAt('/forms/abc/share', 'ws-form')
    expect(read()).toBe('ws-form|named')
    await act(async () => {
      await router.navigate({ to: '/settings/account' })
    })
    expect(read()).toBe('ws-form|guessed')
  })

  it('память пуста — отвечает личное', async () => {
    await renderAt('/settings/account', undefined)
    expect(read()).toBe('personal|guessed')
  })

  it('список пространств ещё не приехал — личного нет, и слаг пуст', async () => {
    await renderAt('/settings/account', undefined, '')
    expect(read()).toBe('|guessed')
  })
})
