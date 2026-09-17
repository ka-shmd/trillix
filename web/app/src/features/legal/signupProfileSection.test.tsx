// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { SignupProfileSection } from './SignupProfileSection'
import type { SignupProfile } from '../../entities/legal'

// Анкета регистрации на странице «Аккаунт» (docs/design/signup-consent.md §3.3): человек
// видит, что указал, правит и очищает это.

const empty: SignupProfile = {
  kind: null,
  fullName: null,
  occupation: null,
  profession: null,
  companyName: null,
  industry: null,
  jobPosition: null,
  purpose: null,
  referral: null,
}

const filled: SignupProfile = {
  ...empty,
  kind: 'person',
  fullName: 'Иванов Иван',
  occupation: 'freelance',
  profession: 'дизайнер',
  purpose: 'leads',
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function stub(profile: SignupProfile) {
  const calls: { method: string; url: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'GET') return Promise.resolve(json(profile))
      return Promise.resolve(new Response(null, { status: 204 }))
    }),
  )
  return calls
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SignupProfileSection />
    </QueryClientProvider>,
  )
}

const rowValue = async (label: string) => {
  const row = (await screen.findByText(label)).closest('li')
  return row?.textContent?.replace(label, '').trim()
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SignupProfileSection', () => {
  it('показывает ответы подписями, незаполненное — прочерком', async () => {
    stub(filled)
    renderSection()
    expect(await rowValue('Кто вы')).toBe('Частное лицо')
    expect(await rowValue('Полное имя')).toBe('Иванов Иван')
    expect(await rowValue('Чем занимаетесь')).toBe('Фриланс или самозанятость')
    expect(await rowValue('Для чего используете')).toBe('Заявки и лиды')
    expect(await rowValue('Как узнали о Trillix')).toBe('—')
    // Вопросов компании у частного лица на экране нет.
    expect(screen.queryByText('Организация или ИП')).toBeNull()
  })

  it('пустая анкета: кнопка зовёт заполнить', async () => {
    stub(empty)
    renderSection()
    expect(await screen.findByRole('button', { name: 'Заполнить' })).toBeTruthy()
  })

  it('правка: окно открыто с прежними ответами, «Сохранить» шлёт анкету целиком', async () => {
    const calls = stub(filled)
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }))

    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('Ваше полное имя') as HTMLInputElement).value).toBe('Иванов Иван')
    fireEvent.change(within(dialog).getByLabelText('Ваша профессия'), { target: { value: 'иллюстратор' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      kind: 'person',
      fullName: 'Иванов Иван',
      occupation: 'freelance',
      profession: 'иллюстратор',
      companyName: null,
      industry: null,
      jobPosition: null,
      purpose: 'leads',
      referral: null,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('«Очистить» опустошает поля, но сохраняет только кнопка', async () => {
    const calls = stub(filled)
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Очистить' }))

    expect((within(dialog).getByLabelText('Ваше полное имя') as HTMLInputElement).value).toBe('')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ ...empty, kind: 'person' })
  })

  it('«Отмена» не сохраняет и не помнит правку при повторном открытии', async () => {
    const calls = stub(filled)
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Ваше полное имя'), { target: { value: 'Кто-то другой' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
    dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('Ваше полное имя') as HTMLInputElement).value).toBe('Иванов Иван')
  })

  it('компания: свои вопросы строками', async () => {
    stub({ ...empty, kind: 'company', companyName: 'ООО «Ромашка»', industry: 'it', jobPosition: 'owner' })
    renderSection()
    expect(await rowValue('Организация или ИП')).toBe('ООО «Ромашка»')
    expect(await rowValue('Сфера деятельности')).toBe('ИТ и разработка')
    expect(await rowValue('Должность')).toBe('Руководитель или собственник')
    expect(screen.queryByText('Профессия')).toBeNull()
  })
})
