import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchPublicForm } from './api'

function stubFetch(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response)),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const validBody = JSON.stringify({
  title: 'Опрос',
  version: 2,
  schema: { schemaVersion: 1, blocks: [{ id: 'b1', type: 'short_text', label: 'Имя' }] },
  token: '1752307200000.sig',
})

describe('fetchPublicForm', () => {
  it('валидный ответ → ok + распарсенная форма', async () => {
    stubFetch(new Response(validBody, { status: 200 }))
    const r = await fetchPublicForm('abc')
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.form.title).toBe('Опрос')
      expect(r.form.version).toBe(2)
      expect(r.form.schema.blocks).toHaveLength(1)
    }
  })
  it('404 → notfound (черновик/закрытая/нет формы неотличимы)', async () => {
    stubFetch(new Response(null, { status: 404 }))
    expect((await fetchPublicForm('draft')).status).toBe('notfound')
  })
  it('прочий не-2xx → исключение (перейдёт в error-экран)', async () => {
    stubFetch(new Response(null, { status: 500 }))
    await expect(fetchPublicForm('abc')).rejects.toThrow()
  })
  it('битое тело → исключение (Zod на границе не пускает мусор внутрь)', async () => {
    stubFetch(new Response('{"title":123}', { status: 200 }))
    await expect(fetchPublicForm('abc')).rejects.toThrow()
  })
})
