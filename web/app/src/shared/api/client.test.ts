import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { apiRequest } from './client'

// Точка выхода в приватный API. Здесь проверяется то, о чём молчит вызывающий:
// что переданное им доезжает до самого fetch.

afterEach(() => {
  vi.unstubAllGlobals()
})

// Отмена нужна там, где ответа можно не дождаться: человек закрыл окно, а запрос
// к чужому API висит до своего таймаута и держит одно из шести соединений
// браузера к origin. Signal, не доехавший до fetch, отменяет ровно ничего — и
// заметно это только накопившимися соединениями, то есть никогда.
it('отмена доезжает до fetch', async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()

  await apiRequest('/ping', { schema: z.object({ ok: z.boolean() }), signal: controller.signal })

  expect(fetchMock.mock.calls[0]![1]!.signal).toBe(controller.signal)
})
