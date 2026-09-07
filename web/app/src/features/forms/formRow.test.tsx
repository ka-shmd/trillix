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

import { type Form } from '../../entities/form'
import { FormRow } from './FormRow'

afterEach(cleanup)

const BASE: Form = {
  id: 'f-1',
  name: 'Заявка на демо',
  title: 'Заявка',
  slug: 'demo01',
  status: 'published',
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-05T10:00:00Z',
  publishedVersion: 1,
  publishedVersionId: 'v-1',
  hasUnpublishedChanges: false,
  submissionCount: 48,
  lastSubmissionAt: '2026-09-07T10:00:00Z',
  visitCount: 312,
  visitSubmittedCount: 47,
}

async function renderRow(form: Partial<Form>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <FormRow form={{ ...BASE, ...form }} workspaceSlug="team" />
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/w/$workspaceSlug/forms/$slug/edit', '/forms/$slug/responses'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
}

// Ссылка названия — та, у которой растянутая область нажатия. Ищется по началу
// доступного имени: значок «Редактировать» — тоже ссылка, и его имя содержит
// название формы целиком («Редактировать «Заявка на демо»»).
function titleLink(label: string): HTMLAnchorElement {
  return screen.getByRole('link', { name: new RegExp(`^${label} —`) }) as HTMLAnchorElement
}

describe('строка списка форм', () => {
  // Правило «черновик в редактор, розданная на ответы» живёт в двух местах — здесь
  // и в выдаче поиска по пространствам. Сторож на оба: разъехавшись, они дали бы
  // разное поведение у одинаковых с виду строк.
  it('черновик ведёт в редактор, розданная форма — на ответы', async () => {
    await renderRow({ status: 'draft', name: 'Черновой опрос' })
    expect(titleLink('Черновой опрос').getAttribute('href')).toBe('/w/team/forms/demo01/edit')
    cleanup()

    await renderRow({ status: 'published' })
    expect(titleLink('Заявка на демо').getAttribute('href')).toBe('/forms/demo01/responses')
    cleanup()

    // Закрытая форма роздана — значит тоже на ответы: её уже заполняли.
    await renderRow({ status: 'closed' })
    expect(titleLink('Заявка на демо').getAttribute('href')).toBe('/forms/demo01/responses')
  })

  // Нажимается ВСЯ строка: областью нажатия служит псевдоэлемент ссылки, растянутый
  // по строке. Снять его — значит вернуть мёртвое поле вокруг двух слов названия.
  it('область нажатия названия растянута на строку', async () => {
    await renderRow({})
    expect(titleLink('Заявка на демо').className).toContain('after:inset-0')
  })

  // У черновика публичной страницы нет — ссылка вела бы на 404.
  it('«Копировать ссылку» выключена у черновика и включена у розданной', async () => {
    await renderRow({ status: 'draft' })
    expect(
      (screen.getByRole('button', { name: /Копировать ссылку/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    cleanup()

    await renderRow({ status: 'published' })
    expect(
      (screen.getByRole('button', { name: /Копировать ссылку/ }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  // Единственное состояние строки, которое может укусить: форму правили после
  // публикации, и респондент видит прежнюю версию.
  it('метка неопубликованных правок показывается только при них', async () => {
    await renderRow({ hasUnpublishedChanges: true })
    expect(screen.getByText('есть неопубликованные правки')).toBeTruthy()
    cleanup()

    await renderRow({ hasUnpublishedChanges: false })
    expect(screen.queryByText('есть неопубликованные правки')).toBeNull()
  })

  // Черновика никто не открывал — у него «нечего считать», а не нули: ноль читался
  // бы как форма, которую все проигнорировали.
  it('у черновика вместо чисел прочерки, у розданной — сами числа', async () => {
    await renderRow({ status: 'draft', visitCount: 0, submissionCount: 0, lastSubmissionAt: null })
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
    cleanup()

    await renderRow({})
    expect(screen.getByText('312')).toBeTruthy()
    expect(screen.getByText('48')).toBeTruthy()
    // Конверсия считается ПО ВИЗИТАМ (47/312), а не делением ответов на просмотры:
    // это разные множества (ADR §10).
    expect(screen.getByText('15 %')).toBeTruthy()
  })

  // Статус несёт не только цвет точки: она декоративна, а слово читает скринридер.
  it('статус назван словом, а не одной точкой', async () => {
    await renderRow({ status: 'published' })
    expect(titleLink('Заявка на демо').textContent).toContain('Опубликована')
  })
})
