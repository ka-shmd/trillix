// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import { ProTag } from './ProTag'

afterEach(cleanup)

// Метка — ссылка роутера, поэтому ей нужен роутер: скелет из двух маршрутов в
// памяти, как в periodNav.test.tsx.
async function renderTag() {
  const rootRoute = createRootRoute()
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    // Заголовок раздела ВОКРУГ метки — часть предмета проверки: `tracking-tight`
    // наследуется внутрь, и без своей разрядки метка сжималась бы именно здесь.
    component: () => (
      <h2 className="text-xl font-bold tracking-tight">
        Незавершённые ответы <ProTag />
      </h2>
    ),
  })
  const plan = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/plan',
    component: () => <span>тариф</span>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, plan]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
  // Роутер отдаёт дерево не в первом кадре — ждём загрузки маршрута, как в
  // periodNav.test.tsx.
  await act(async () => {
    await router.load()
  })
  return screen.getByRole('link', { name: 'ПРО' })
}

describe('метка платной возможности', () => {
  it('ведёт на страницу тарифа', async () => {
    // Метка сообщает об ограничении и обязана давать путь узнать цену тем же
    // жестом, каким её заметили. Адрес аккаунтный: план один на человека, и
    // называть в ссылке пространство было бы обещанием, что у него свой тариф.
    expect((await renderTag()).getAttribute('href')).toBe('/settings/plan')
  })

  it('несёт свои вес и разрядку, а базовые классы бейджа их не перебивают', async () => {
    // ГРАБЛИ, ради которых тест и написан: `font-medium` из базы `Badge` и
    // `font-extrabold` метки — взаимоисключающие утилиты одинаковой специфичности,
    // и разрулить их обязан tailwind-merge внутри `cn`. Подменят `cn` на `clsx` —
    // в строке окажутся оба класса, и победит порядок в сгенерированном CSS, а не
    // в разметке. Разрядка тут же: без неё три заглавные буквы слипаются под
    // унаследованным `tracking-tight` заголовка.
    const cls = (await renderTag()).className
    expect(cls).toContain('font-extrabold')
    expect(cls).not.toContain('font-medium')
    expect(cls).toContain('tracking-wide')
  })
})
