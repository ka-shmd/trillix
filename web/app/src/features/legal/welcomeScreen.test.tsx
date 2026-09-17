// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { WelcomeScreen } from './WelcomeScreen'
import type { Consents } from '../../entities/legal'

// Экран согласия (docs/design/signup-consent.md §1, пп. 1, 3–5; §3.3): единственное действие
// доступно, как только отмечено соглашение; анкета уходит по выбранной вкладке.

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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

function renderScreen(defaultFullName = '') {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const onDone = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <WelcomeScreen defaultFullName={defaultFullName} onDone={onDone} />
    </QueryClientProvider>,
  )
  return { onDone }
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement
const checkTerms = () => fireEvent.click(screen.getByRole('checkbox', { name: /Принимаю/ }))
// Радиксовая вкладка переключается нажатием кнопки мыши, а не щелчком.
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('экран «Поделитесь парой деталей»', () => {
  it('одна кнопка, и она доступна только с галочкой соглашения', async () => {
    stubApi(consents('signup'))
    renderScreen()
    await screen.findByText('Поделитесь парой деталей')

    expect(screen.getAllByRole('button').map((b) => b.textContent)).not.toContain('Пропустить')
    expect(screen.queryByRole('button', { name: 'Выйти' })).toBeNull()
    expect(button('Завершить регистрацию').disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /Даю согласие/ }))
    expect(button('Завершить регистрацию').disabled).toBe(true)

    checkTerms()
    expect(button('Завершить регистрацию').disabled).toBe(false)
  })

  it('частное лицо: ФИО подставлено из профиля, вопросы вкладки и общие', async () => {
    stubApi(consents('signup'))
    renderScreen('Петров Иван')
    await screen.findByText('Поделитесь парой деталей')

    expect(screen.getByRole('tab', { name: 'Частное лицо' }).getAttribute('aria-selected')).toBe('true')
    expect(input('Ваше полное имя').value).toBe('Петров Иван')
    for (const label of ['Чем вы занимаетесь?', 'Ваша профессия', 'Как вы о нас узнали?', 'Для чего вы будете использовать Trillix?']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    expect(screen.queryByLabelText('Название организации или ИП')).toBeNull()
  })

  it('«Завершить регистрацию»: сначала согласия, потом анкета частного лица', async () => {
    const calls = stubApi(consents('signup'))
    const { onDone } = renderScreen('Петров Иван')
    await screen.findByText('Поделитесь парой деталей')
    fireEvent.change(input('Ваше полное имя'), { target: { value: 'Петров Иван Сергеевич ' } })
    fireEvent.change(input('Ваша профессия'), { target: { value: 'дизайнер' } })
    checkTerms()
    fireEvent.click(screen.getByRole('checkbox', { name: /Даю согласие/ }))
    fireEvent.click(button('Завершить регистрацию'))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/v1/account/consents',
      'PUT /api/v1/account/signup-profile',
    ])
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      accept: [
        { kind: 'terms', version: '2026-09-17' },
        { kind: 'marketing', version: '2026-09-17' },
      ],
    })
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      kind: 'person',
      fullName: 'Петров Иван Сергеевич',
      occupation: null,
      profession: 'дизайнер',
      companyName: null,
      industry: null,
      jobPosition: null,
      purpose: null,
      referral: null,
    })
  })

  it('компания или ИП: свои вопросы, поля частного лица не уходят', async () => {
    const calls = stubApi(consents('signup'))
    const { onDone } = renderScreen()
    await screen.findByText('Поделитесь парой деталей')
    fireEvent.change(input('Ваша профессия'), { target: { value: 'дизайнер' } })

    openTab('Компания или ИП')
    expect(await screen.findByLabelText('Название организации или ИП')).toBeTruthy()
    expect(screen.getByLabelText('Сфера деятельности')).toBeTruthy()
    expect(screen.getByLabelText('Ваша должность')).toBeTruthy()
    expect(screen.queryByLabelText('Ваша профессия')).toBeNull()

    fireEvent.change(input('Ваше полное имя'), { target: { value: 'Иванов Иван' } })
    fireEvent.change(input('Название организации или ИП'), { target: { value: 'ООО «Ромашка»' } })
    checkTerms()
    fireEvent.click(button('Завершить регистрацию'))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    // Галочка рассылок не отмечена — принимается только соглашение.
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ accept: [{ kind: 'terms', version: '2026-09-17' }] })
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      kind: 'company',
      fullName: 'Иванов Иван',
      companyName: 'ООО «Ромашка»',
      profession: null,
      occupation: null,
    })
  })

  it('переключение вкладки не стирает набранное', async () => {
    stubApi(consents('signup'))
    renderScreen()
    await screen.findByText('Поделитесь парой деталей')
    openTab('Компания или ИП')
    fireEvent.change(await screen.findByLabelText('Название организации или ИП'), { target: { value: 'ООО «Ромашка»' } })
    openTab('Частное лицо')
    openTab('Компания или ИП')
    expect(((await screen.findByLabelText('Название организации или ИП')) as HTMLInputElement).value).toBe('ООО «Ромашка»')
  })

  it('ссылки ведут на те самые редакции документов в новой вкладке', async () => {
    stubApi(consents('signup'))
    renderScreen()
    const terms = (await screen.findByRole('link', { name: 'Пользовательское соглашение' })) as HTMLAnchorElement
    expect(terms.getAttribute('href')).toBe('/legal/terms?version=2026-09-17')
    expect(terms.target).toBe('_blank')
    expect(screen.getByRole('link', { name: 'согласие' }).getAttribute('href')).toBe('/legal/marketing?version=2026-09-17')
    // Строки «Как мы обрабатываем данные» на экране нет (решение владельца 2026-09-17).
    expect(screen.queryByRole('link', { name: 'Политика обработки персональных данных' })).toBeNull()
  })

  it('отказ сервера показан по-русски, анкета не уходит, в кабинет не пускает', async () => {
    const calls = stubApi(consents('signup'), () =>
      json({ error: { code: 'validation_failed', message: 'редакция документа обновилась — обновите страницу' } }, 422),
    )
    const { onDone } = renderScreen()
    await screen.findByText('Поделитесь парой деталей')
    checkTerms()
    fireEvent.click(button('Завершить регистрацию'))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'редакция документа обновилась — обновите страницу')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('экран «Условия использования обновились»', () => {
  it('одна галочка соглашения, без анкеты и рассылок; «Принять и продолжить» шлёт только соглашение', async () => {
    const calls = stubApi(consents('update'))
    const { onDone } = renderScreen('Петров Иван')
    await screen.findByText('Условия использования обновились')

    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Даю согласие/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Выйти' })).toBeNull()
    expect(button('Принять и продолжить').disabled).toBe(true)

    checkTerms()
    fireEvent.click(button('Принять и продолжить'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ accept: [{ kind: 'terms', version: '2026-09-17' }] })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})

it('согласие уже дано — экран сразу возвращает человека', async () => {
  stubApi(consents(null))
  const { onDone } = renderScreen()
  await waitFor(() => expect(onDone).toHaveBeenCalled())
})
