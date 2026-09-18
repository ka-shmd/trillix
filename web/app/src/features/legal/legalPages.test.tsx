// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'

import { LegalDocumentPage } from './LegalPages'

// Публичная страница документа (docs/design/signup-consent.md §1, п. 6): текст разложен на
// разделы, прежняя редакция помечена и ведёт к действующей, неизвестная — отказ словами.

const doc = (version: string) => ({
  kind: 'terms',
  title: 'Пользовательское соглашение',
  version,
  effectiveAt: `${version}T00:00:00+03:00`,
  text: 'Вступление.\n\n1. Термины\n\n1.1. Сервис — программа.',
  versions: [
    { version: '2026-10-01', effectiveAt: '2026-10-01T00:00:00+03:00' },
    { version: '2026-09-17', effectiveAt: '2026-09-17T00:00:00+03:00' },
  ],
})

function renderPage(version: string, response: Response) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response)))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: '/legal/$kind',
    component: () => <LegalDocumentPage kind="terms" version={version} />,
  })
  const index = createRoute({ getParentRoute: () => root, path: '/legal', component: () => null })
  const router = createRouter({
    routeTree: root.addChildren([page, index]),
    history: createMemoryHistory({ initialEntries: ['/legal/terms'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('LegalDocumentPage', () => {
  it('действующая редакция: разделы заголовками, архив со ссылкой на прежнюю', async () => {
    renderPage('', json(doc('2026-10-01')))
    expect(await screen.findByRole('heading', { level: 2, name: '1. Термины' })).toBeTruthy()
    expect(screen.getByText('1.1. Сервис — программа.').tagName).toBe('P')
    expect(screen.queryByText('Это прежняя редакция.', { exact: false })).toBeNull()
    const past = screen.getByRole('link', { name: /Действовала с/ })
    expect(past.getAttribute('href')).toBe('/legal/terms?version=2026-09-17')
  })

  // РЕГРЕССИЯ (найдено владельцем): заголовок страницы обрезался многоточием — название
  // документа «Согласие на получение рекламных и информационных рассылок» не влезает в строку
  // ни на одной ширине, и прочитать его было нельзя.
  it('название документа переносится, а не обрезается', async () => {
    renderPage('', json(doc('2026-10-01')))
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Пользовательское соглашение' })
    expect(h1.className).not.toContain('truncate')
  })

  it('прежняя редакция помечена и ведёт к действующей', async () => {
    renderPage('2026-09-17', json(doc('2026-09-17')))
    expect(await screen.findByText('Это прежняя редакция.', { exact: false })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть действующую' }).getAttribute('href')).toBe('/legal/terms')
  })

  it('неизвестная редакция — «Такой редакции нет», а не сбой', async () => {
    renderPage('2020-01-01', json({ error: { code: 'not_found', message: 'not found' } }, 404))
    expect(await screen.findByText('Такой редакции нет')).toBeTruthy()
  })
})
