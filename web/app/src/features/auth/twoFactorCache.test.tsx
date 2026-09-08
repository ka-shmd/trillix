// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { authKeys } from './keys'
import { useEnableTwoFactor } from './queries'

// Включение и выключение фактора забывают на бэке ВСЕ известные устройства
// (docs/design/two-factor-email.md §6). Забытая инвалидация здесь — не мелочь:
// список продолжал бы показывать браузеры, которым код уже нужен, и кнопка
// «забыть» под ними ничего бы не значила.

const enabled = {
  id: 'u1',
  email: 'ivan@example.com',
  emailVerified: true,
  firstName: 'Иван',
  lastName: 'Петров',
  hasPassword: true,
  avatarKey: '',
  twoFactorEnabled: true,
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(enabled), {
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

it('включение фактора патчит профиль и обесценивает список устройств', async () => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData(authKeys.me(), { ...enabled, twoFactorEnabled: false })
  qc.setQueryData(authKeys.devices(), [
    { id: 'd1', label: 'Chrome на Windows', lastSeenAt: '', createdAt: '', current: true },
  ])
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )

  const { result } = renderHook(() => useEnableTwoFactor(), { wrapper })
  await act(async () => {
    result.current.mutate({ currentPassword: 'supersecret' })
  })

  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  // Профиль патчится ответом, а не перезапрашивается: лишний круг за /auth/me
  // показал бы переключатель в старом положении на время запроса.
  expect(qc.getQueryData(authKeys.me())).toMatchObject({ twoFactorEnabled: true })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: authKeys.devices() })
})
