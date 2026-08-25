import { describe, expect, it, vi } from 'vitest'

import { fetchFormToken, holdUntilAccepted, type FormToken } from './formToken'

// Возраст токена задаётся смещением от «сейчас» по монотонным часам — той же мерой,
// какой его меряет сам модуль.
function tokenAgedMs(age: number): FormToken {
  return { value: 'stub.token', receivedAt: performance.now() - age }
}

describe('holdUntilAccepted', () => {
  it('додерживает свежий токен вместо отказа', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    await holdUntilAccepted(tokenAgedMs(0), sleep)

    expect(sleep).toHaveBeenCalledTimes(1)
    // Ждём порог сервера (3 с) плюс небольшой запас — точное число тест не
    // фиксирует, иначе он ломался бы на правке запаса, ничего не проверяя.
    const [waited] = sleep.mock.calls[0] as [number]
    expect(waited).toBeGreaterThan(3000)
    expect(waited).toBeLessThan(4000)
  })

  it('не ждёт вовсе, если человек уже провёл на форме больше порога', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    await holdUntilAccepted(tokenAgedMs(10_000), sleep)

    expect(sleep).not.toHaveBeenCalled()
  })

  it('ждёт только остаток, а не полный порог', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    await holdUntilAccepted(tokenAgedMs(2500), sleep)

    const [waited] = sleep.mock.calls[0] as [number]
    expect(waited).toBeLessThan(1000)
    expect(waited).toBeGreaterThan(0)
  })
})

describe('fetchFormToken', () => {
  it('берёт токен отдельной ручкой и запоминает момент получения', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: '1756123456789.sig' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const before = performance.now()
    const token = await fetchFormToken()

    // Адрес ручки — часть контракта: токен обязан ехать НЕ из кэшируемого тела
    // схемы формы (ADR §10).
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('/public/v1/form-token')
    expect(token.value).toBe('1756123456789.sig')
    expect(token.receivedAt).toBeGreaterThanOrEqual(before)

    vi.unstubAllGlobals()
  })

  it('падает исключением, если токен не выдан: без него ответ принять нельзя', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }))

    await expect(fetchFormToken()).rejects.toThrow('HTTP 429')

    vi.unstubAllGlobals()
  })
})
