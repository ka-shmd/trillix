// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import { TemplatesView } from './TemplatesView'
import { TEMPLATES, questionCaptions } from './templates'

// Сторожа на то, что ломается МОЛЧА. Плитка теперь показывает саму форму, и обещание
// «увидишь то же, что получишь» не проверяется ни типами, ни тестом на поведение:
// подмени лист картинкой-заглушкой — экран продолжит работать, а обещание исчезнет.
// Второе такое место — `inert` на миниатюре: без него каждая плитка приводит тому,
// кто ходит табом, семь полей, в которые нельзя писать.

const FORM = {
  id: 'f-1',
  name: null,
  title: 'Обратная связь',
  slug: 'obratnaya-svyaz',
  status: 'draft',
  createdAt: '2026-09-08T10:00:00Z',
  updatedAt: '2026-09-08T10:00:00Z',
  publishedVersion: null,
  publishedVersionId: null,
  hasUnpublishedChanges: false,
  submissionCount: 0,
  lastSubmissionAt: null,
  visitCount: 0,
  visitSubmittedCount: 0,
}

let calls: string[] = []

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return Promise.resolve(
        new Response(JSON.stringify(FORM), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Галерея заводит форму и уводит в редактор, поэтому живёт внутри роутера — как и
// в кабинете.
async function renderGallery() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <TemplatesView workspaceId="ws-1" workspaceSlug="team" />
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/w/$workspaceSlug/templates', '/w/$workspaceSlug/forms/$slug/edit'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ['/w/team/templates'] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
}

const first = TEMPLATES[0]!

it('плитка показывает саму форму, а не рассказ о ней', async () => {
  await renderGallery()
  const tile = screen.getByRole('button', {
    name: `Посмотреть шаблон «${first.title}»`,
  }).parentElement!

  // Заголовок формы и её вопросы стоят в плитке разметкой полотна (rf-*), а не
  // строчками списка: подмена листа заглушкой уронит этот тест.
  expect(tile.querySelector('.rf-page')).not.toBeNull()
  for (const caption of questionCaptions(first)) {
    expect(within(tile).getAllByText(caption).length).toBeGreaterThan(0)
  }
})

it('контролы листа не disabled — иначе показывался бы не тот вид', async () => {
  await renderGallery()

  // `disabled` — не «то же самое, но нельзя трогать»: `.rf-submit:disabled` гасит
  // кнопку до половинной прозрачности, а `.rf-input:disabled` подставляет полю
  // прозрачный фон вместо `--rf-field-bg` (TD-73). То есть ровно тот вид, который
  // галерея обещает показать, disabled и подменяет. Неинтерактивность держит `inert`
  // на коробке миниатюры, а не запрет на контролах.
  const sheet = document.querySelector('.tpl-sheet')!
  for (const control of Array.from(sheet.querySelectorAll('input, textarea, select, button'))) {
    expect(control.hasAttribute('disabled')).toBe(false)
  }
})

it('миниатюра inert — поля формы не забирают табы и не звучат у диктора', async () => {
  await renderGallery()
  const thumb = document.querySelector('.tpl-thumb')!
  expect(thumb.hasAttribute('inert')).toBe(true)
  expect(thumb.getAttribute('aria-hidden')).toBe('true')
})

it('нажатие на плитку открывает просмотр, оттуда заводится форма', async () => {
  await renderGallery()
  fireEvent.click(screen.getByRole('button', { name: `Посмотреть шаблон «${first.title}»` }))

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(first.description)).toBeTruthy()
  // Окно называет, сколько вопросов получит автор.
  expect(within(dialog).getByText(new RegExp(`^${questionCaptions(first).length}\\s`))).toBeTruthy()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Использовать шаблон' }))

  // Два запроса подряд: пустая форма, затем её черновик (queries.ts).
  await waitFor(() => expect(calls).toEqual(['POST /api/v1/forms', 'PATCH /api/v1/forms/f-1']))
})
