// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { LegalSettings } from './LegalSettings'
import { TermsUpdateBanner } from './TermsUpdateBanner'
import type { Consents } from '../../entities/legal'

// «Правовая информация» и баннер новой редакции (docs/design/signup-consent.md §1, пп. 5–6).

const documents = {
  items: [
    { kind: 'terms', title: 'Пользовательское соглашение', version: '2026-10-01', effectiveAt: '2026-10-01T00:00:00+03:00' },
    { kind: 'privacy', title: 'Политика обработки персональных данных', version: '2026-09-17', effectiveAt: '2026-09-17T00:00:00+03:00' },
  ],
}

function consents(over: { granted?: boolean; accepted?: string; current?: string; screen?: Consents['screen'] } = {}): Consents {
  const current = over.current ?? '2026-09-17'
  return {
    screen: over.screen ?? null,
    terms: {
      version: current,
      effectiveAt: `${current}T00:00:00+03:00`,
      title: 'Пользовательское соглашение',
      label: 'Принимаю Пользовательское соглашение',
      link: 'Пользовательское соглашение',
      acceptedVersion: over.accepted ?? '2026-09-17',
      acceptedAt: '2026-09-17T10:00:00+03:00',
    },
    marketing: {
      version: '2026-09-17',
      effectiveAt: '2026-09-17T00:00:00+03:00',
      title: 'Согласие на получение рекламных и информационных рассылок',
      label: 'Даю согласие на получение новостей и предложений Trillix',
      link: 'согласие',
      toggleLabel: 'Новости и предложения Trillix',
      granted: over.granted ?? false,
      grantedVersion: over.granted ? '2026-09-17' : null,
      changedAt: over.granted ? '2026-09-17T10:00:00+03:00' : null,
    },
    history: [
      { id: 'e2', kind: 'marketing', version: '2026-09-17', title: 'Согласие на получение рекламных и информационных рассылок', action: 'withdrawn', source: 'settings', at: '2026-09-18T10:00:00+03:00' },
      { id: 'e1', kind: 'terms', version: '2026-09-17', title: 'Пользовательское соглашение', action: 'accepted', source: 'signup_yandex', at: '2026-09-17T10:00:00+03:00' },
    ],
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stub(state: Consents, afterPost: Consents = state) {
  const posts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(json(afterPost))
      }
      if (url.startsWith('/api/v1/legal/documents')) return Promise.resolve(json(documents))
      return Promise.resolve(json(state))
    }),
  )
  return posts
}

// settled — дождаться, пока запрос согласий ушёл и его ответ отрисован: «баннера нет» до
// ответа доказывало бы только то, что данных ещё нет.
async function settled() {
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 20))
}

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('LegalSettings', () => {
  it('документы — ссылками на публичные страницы в новой вкладке', async () => {
    stub(consents())
    renderWith(<LegalSettings />)
    const privacy = await screen.findByRole('link', { name: 'Политика обработки персональных данных' })
    expect(privacy.getAttribute('href')).toBe('/legal/privacy')
    expect(privacy.getAttribute('target')).toBe('_blank')
  })

  it('тумблер рассылок: включение принимает действующую редакцию, выключение отзывает', async () => {
    const posts = stub(consents({ granted: false }), consents({ granted: true }))
    renderWith(<LegalSettings />)
    const toggle = await screen.findByRole('switch', { name: 'Новости и предложения Trillix' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(posts).toEqual([{ accept: [{ kind: 'marketing', version: '2026-09-17' }] }])

    fireEvent.click(toggle)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]).toEqual({ withdraw: ['marketing'] })
  })

  it('история: действие, ссылка на ту самую редакцию, источник', async () => {
    stub(consents())
    renderWith(<LegalSettings />)
    const history = (await screen.findByText('Ваши согласия')).closest('section')!
    const [withdrawn, accepted, ...rest] = within(history).getAllByRole('listitem')
    expect(rest).toHaveLength(0)
    expect(withdrawn?.textContent).toContain('Отозвано')
    expect(withdrawn?.textContent).toContain('В правовой информации')
    expect(accepted?.textContent).toContain('Принято')
    expect(accepted?.textContent).toContain('При регистрации')
    expect(within(accepted!).getByRole('link').getAttribute('href')).toBe('/legal/terms?version=2026-09-17')
  })

  it('отказ загрузки согласий нарисован', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.startsWith('/api/v1/legal/documents')
            ? json(documents)
            : json({ error: { code: 'internal', message: 'internal' } }, 500),
        ),
      ),
    )
    renderWith(<LegalSettings />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('TermsUpdateBanner', () => {
  it('принятая редакция — действующая: баннера нет', async () => {
    stub(consents())
    renderWith(<TermsUpdateBanner />)
    await settled()
    expect(screen.queryByText('Условия использования обновились')).toBeNull()
  })

  it('вышла несущественная редакция: баннер со ссылкой; закрытие запоминается по версии', async () => {
    stub(consents({ current: '2026-10-01', accepted: '2026-09-17' }))
    renderWith(<TermsUpdateBanner />)
    await screen.findByText('Условия использования обновились')
    expect(screen.getByRole('link', { name: 'Прочитать' }).getAttribute('href')).toBe('/legal/terms?version=2026-10-01')

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(screen.queryByText('Условия использования обновились')).toBeNull()
    expect(window.localStorage.getItem('trillix.termsBanner.dismissed')).toBe('2026-10-01')

    cleanup()
    renderWith(<TermsUpdateBanner />)
    await settled()
    expect(screen.queryByText('Условия использования обновились')).toBeNull()
  })

  it('следующая редакция возвращает закрытый баннер', async () => {
    window.localStorage.setItem('trillix.termsBanner.dismissed', '2026-10-01')
    stub(consents({ current: '2026-11-01', accepted: '2026-09-17' }))
    renderWith(<TermsUpdateBanner />)
    expect(await screen.findByText('Условия использования обновились')).toBeTruthy()
  })

  it('кабинет закрыт гейтом — баннер не нужен, там экран согласия', async () => {
    stub(consents({ current: '2026-10-01', accepted: '2026-09-17', screen: 'update' }))
    renderWith(<TermsUpdateBanner />)
    await settled()
    expect(screen.queryByText('Условия использования обновились')).toBeNull()
  })
})
