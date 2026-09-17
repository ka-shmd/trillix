// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { WelcomeScreen } from './WelcomeScreen'
import { profileOf, type Consents } from '../../entities/legal'

// Экран согласия (docs/design/signup-consent.md §1, пп. 1, 3–5): что нельзя нажать до
// галочки соглашения и что уходит на сервер с каждой кнопкой.

const offer = { version: '2026-09-17', effectiveAt: '2026-09-17T00:00:00+03:00' }

function consents(screenName: Consents['screen']): Consents {
  return {
    screen: screenName,
    terms: {
      ...offer,
      title: 'Пользовательское соглашение',
      label: 'Принимаю Пользовательское соглашение',
      link: 'Пользовательское соглашение',
      acceptedVersion: null,
      acceptedAt: null,
    },
    marketing: {
      ...offer,
      title: 'Согласие на получение рекламных и информационных рассылок',
      label: 'Даю согласие на получение новостей и предложений Trillix',
      link: 'согласие',
      toggleLabel: 'Новости и предложения Trillix',
      granted: false,
      grantedVersion: null,
      changedAt: null,
    },
    history: [],
  }
}

interface Call {
  method: string
  url: string
  body: unknown
}

function stubApi(initial: Consents, post: () => Response = () => json(consents(null))) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'GET') return Promise.resolve(json(initial))
      if (method === 'POST') return Promise.resolve(post())
      return Promise.resolve(new Response(null, { status: 204 }))
    }),
  )
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const onDone = vi.fn()
  const onLogout = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <WelcomeScreen email="new@example.com" onDone={onDone} onLogout={onLogout} logoutPending={false} />
    </QueryClientProvider>,
  )
  return { onDone, onLogout }
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('экран «Завершение регистрации»', () => {
  it('без галочки соглашения кнопки в кабинет неактивны, «Выйти» — нет', async () => {
    stubApi(consents('signup'))
    const { onLogout } = renderScreen()
    await screen.findByText('Завершение регистрации')

    expect((screen.getByLabelText('Email') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('new@example.com')
    expect(button('Пропустить').disabled).toBe(true)
    expect(button('Завершить регистрацию').disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /Даю согласие/ }))
    expect(button('Пропустить').disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /Принимаю/ }))
    expect(button('Пропустить').disabled).toBe(false)
    expect(button('Завершить регистрацию').disabled).toBe(false)

    fireEvent.click(button('Выйти'))
    expect(onLogout).toHaveBeenCalled()
  })

  it('ссылки ведут на те самые редакции документов в новой вкладке', async () => {
    stubApi(consents('signup'))
    renderScreen()
    const terms = (await screen.findByRole('link', { name: 'Пользовательское соглашение' })) as HTMLAnchorElement
    expect(terms.getAttribute('href')).toBe('/legal/terms?version=2026-09-17')
    expect(terms.target).toBe('_blank')
    expect(screen.getByRole('link', { name: 'согласие' }).getAttribute('href')).toBe('/legal/marketing?version=2026-09-17')
    expect(screen.getByRole('link', { name: 'Политика обработки персональных данных' }).getAttribute('href')).toBe('/legal/privacy')
  })

  it('«Пропустить» принимает отмеченное и не шлёт анкету', async () => {
    const calls = stubApi(consents('signup'))
    const { onDone } = renderScreen()
    await screen.findByText('Завершение регистрации')
    fireEvent.click(screen.getByRole('checkbox', { name: /Принимаю/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Даю согласие/ }))
    fireEvent.click(button('Пропустить'))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('/api/v1/account/consents')
    expect(post?.body).toEqual({
      accept: [
        { kind: 'terms', version: '2026-09-17' },
        { kind: 'marketing', version: '2026-09-17' },
      ],
    })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('«Завершить регистрацию» без ответов анкету не шлёт, без галочки рассылок — только соглашение', async () => {
    const calls = stubApi(consents('signup'))
    const { onDone } = renderScreen()
    await screen.findByText('Завершение регистрации')
    fireEvent.click(screen.getByRole('checkbox', { name: /Принимаю/ }))
    fireEvent.click(button('Завершить регистрацию'))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ accept: [{ kind: 'terms', version: '2026-09-17' }] })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('отказ сервера показан по-русски, в кабинет не пускает', async () => {
    stubApi(consents('signup'), () =>
      json({ error: { code: 'validation_failed', message: 'редакция документа обновилась — обновите страницу' } }, 422),
    )
    const { onDone } = renderScreen()
    await screen.findByText('Завершение регистрации')
    fireEvent.click(screen.getByRole('checkbox', { name: /Принимаю/ }))
    fireEvent.click(button('Пропустить'))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'редакция документа обновилась — обновите страницу')
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('экран «Условия использования обновились»', () => {
  it('одна галочка соглашения, без рассылок и анкеты; «Принять» шлёт только соглашение', async () => {
    const calls = stubApi(consents('update'))
    const { onDone } = renderScreen()
    await screen.findByText('Условия использования обновились')

    expect(screen.queryByRole('checkbox', { name: /Даю согласие/ })).toBeNull()
    expect(screen.queryByText('Расскажите о себе')).toBeNull()
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(button('Принять').disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /Принимаю/ }))
    fireEvent.click(button('Принять'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ accept: [{ kind: 'terms', version: '2026-09-17' }] })
  })
})

it('согласие уже дано — экран сразу возвращает человека', async () => {
  stubApi(consents(null))
  const { onDone } = renderScreen()
  await waitFor(() => expect(onDone).toHaveBeenCalled())
})

describe('profileOf', () => {
  it('без единого ответа анкеты нет', () => {
    expect(profileOf({ kind: null, purpose: null, referral: null })).toBeNull()
  })
  it('частичная анкета уходит как есть', () => {
    expect(profileOf({ kind: 'company', purpose: null, referral: null })).toEqual({
      kind: 'company',
      purpose: null,
      referral: null,
    })
  })
})
