// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { authKeys } from './keys'
import { useUpdateProfile } from './queries'

// Забытая синхронизация кэша — баг, а не мелочь (web/CLAUDE.md): без патча
// authKeys.me() сайдбар продолжал бы звать человека прежним именем до
// перезагрузки страницы, хотя сервер уже ответил новым.

const saved = {
  id: 'u1',
  email: 'ivan@example.com',
  emailVerified: true,
  firstName: 'Иван',
  lastName: 'Петров',
  hasPassword: true,
  twoFactorEnabled: false,
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(saved), {
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

it('успешная правка профиля патчит кэш me ответом сервера', async () => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData(authKeys.me(), { ...saved, firstName: '', lastName: '' })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )

  const { result } = renderHook(() => useUpdateProfile(), { wrapper })
  act(() => {
    result.current.mutate({ firstName: 'Иван', lastName: 'Петров' })
  })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(qc.getQueryData(authKeys.me())).toMatchObject({
    firstName: 'Иван',
    lastName: 'Петров',
  })
})
