// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { formKeys } from '../forms/keys'
import { authKeys } from './keys'
import { useLogin, useLogout } from './queries'

// Регрессия TD-40: данные предыдущего аккаунта видны после смены личности в той же
// вкладке. Это клиентский протухший кэш, а не серверная утечка сессии — на сервере
// личность определяется исключительно cookie session. Значит и проверяется это
// состоянием QueryClient: после выхода и после входа в кэше не должно остаться
// НИЧЕГО от прежнего аккаунта, а не только вычищенный authKeys.me().

const userB = {
  id: 'user-b',
  email: 'b@example.com',
  emailVerified: true,
  createdAt: '2026-07-26T10:00:00.000Z',
  // Профиль обязателен в схеме с фазы 23: ответ без него не пройдёт userSchema
  // на границе, и мутация упадёт ещё до onSuccess.
  firstName: '',
  lastName: '',
  hasPassword: true,
  avatarKey: '',
  twoFactorEnabled: false,
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(userB), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// seedAccountA — кэш вкладки, в которой поработал аккаунт A: профиль плюс его
// серверные данные (список форм — самое заметное, оно рисуется на дашборде сразу).
function seedAccountA(qc: QueryClient) {
  qc.setQueryData(authKeys.me(), { id: 'user-a', email: 'a@example.com' })
  qc.setQueryData(formKeys.list(), { forms: [{ id: 'form-a', title: 'Форма аккаунта A' }] })
  qc.setQueryData(formKeys.detail('anketa-a'), { id: 'form-a', title: 'Форма аккаунта A' })
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  seedAccountA(qc)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, wrapper }
}

// Всё, что лежит в кэше, кроме профиля: именно это утекало между аккаунтами.
const leftovers = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .getAll()
    .map((q) => q.queryKey)
    .filter((k) => String(k[0]) !== 'auth')

describe('TD-40: смена личности в той же вкладке чистит клиентский кэш', () => {
  it('logout не оставляет данных вышедшего аккаунта', async () => {
    const { qc, wrapper } = setup()
    expect(leftovers(qc)).not.toEqual([])

    const { result } = renderHook(() => useLogout(), { wrapper })
    await act(async () => {
      result.current.mutate()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(leftovers(qc)).toEqual([])
    expect(qc.getQueryData(authKeys.me())).toBeUndefined()
  })

  it('вход другим аккаунтом не наследует кэш прежнего, но кладёт нового в me', async () => {
    const { qc, wrapper } = setup()

    const { result } = renderHook(() => useLogin(), { wrapper })
    await act(async () => {
      result.current.mutate({ email: userB.email, password: 'irrelevant' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(leftovers(qc)).toEqual([])
    // clear() идёт ПЕРЕД setQueryData, иначе свежий профиль вычистился бы вместе
    // с чужими данными и гард _app сходил бы за ним ещё раз.
    expect(qc.getQueryData(authKeys.me())).toMatchObject({ id: 'user-b' })
  })
})
