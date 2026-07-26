import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchPublicForm, submitAnswers } from './api'

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
  schema: { schemaVersion: 3, blocks: [{ id: 'b1', groupId: 'g_b1', type: 'short_text', required: true }] },
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
  it('404 → notfound (черновик/несуществующая неотличимы)', async () => {
    stubFetch(new Response(null, { status: 404 }))
    expect((await fetchPublicForm('draft')).status).toBe('notfound')
  })
  it('410 → closed + название и текст «приём закрыт» из тела', async () => {
    stubFetch(
      new Response('{"closed":true,"title":"Регистрация","closedMessage":"Мест больше нет"}', {
        status: 410,
      }),
    )
    const r = await fetchPublicForm('full')
    expect(r.status).toBe('closed')
    if (r.status === 'closed') {
      expect(r.title).toBe('Регистрация')
      expect(r.message).toBe('Мест больше нет')
    }
  })
  it('410 с битым телом → исключение (Zod на границе)', async () => {
    stubFetch(new Response('{"closed":true}', { status: 410 }))
    await expect(fetchPublicForm('full')).rejects.toThrow()
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

const body = { submissionId: '018f-id', token: 'tok', answers: { b1: 'Анна' }, visitId: '018f-visit' }

describe('submitAnswers', () => {
  it('201 → ok, а тело шлёт honeypot пустым и snake_case-поля', async () => {
    const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response('{"id":"018f-id"}', { status: 201 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect((await submitAnswers('abc', body)).status).toBe('ok')
    const init = fetchMock.mock.calls[0]?.[1]
    const sent = JSON.parse(init!.body as string) as Record<string, unknown>
    expect(sent).toMatchObject({ submission_id: '018f-id', token: 'tok', website: '' })
    expect(sent.answers).toEqual({ b1: 'Анна' })
    // Визит уезжает вместе с ответом — отсюда точная конверсия (фаза 8.5 шаг 6).
    expect(sent.visit_id).toBe('018f-visit')
  })

  it('422 с fields → invalid + карта полей', async () => {
    stubFetch(
      new Response('{"error":{"code":"validation_failed","message":"m","fields":{"b1":"обязательное поле"}}}', {
        status: 422,
      }),
    )
    const r = await submitAnswers('abc', body)
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.fields.b1).toBe('обязательное поле')
  })

  it('422 без fields (антиспам) → rejected с сообщением', async () => {
    stubFetch(
      new Response('{"error":{"code":"validation_failed","message":"форма отправлена слишком быстро"}}', {
        status: 422,
      }),
    )
    const r = await submitAnswers('abc', body)
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.message).toContain('быстро')
  })

  it('410 → closed (форма закрылась: снята/дата/лимит)', async () => {
    stubFetch(new Response('{"error":{"code":"form_closed","message":"приём закрыт"}}', { status: 410 }))
    expect((await submitAnswers('abc', body)).status).toBe('closed')
  })

  it('404 → closed (форма исчезла)', async () => {
    stubFetch(new Response(null, { status: 404 }))
    expect((await submitAnswers('abc', body)).status).toBe('closed')
  })

  it('429 → rejected', async () => {
    stubFetch(new Response('{"error":{"code":"rate_limited","message":"слишком много"}}', { status: 429 }))
    expect((await submitAnswers('abc', body)).status).toBe('rejected')
  })

  it('500 с нашим конвертом → rejected БЕЗ служебного текста сервера', async () => {
    // Респондент не должен читать внутренности. Живой случай: сервер не смог
    // разобрать схему версии и слал наружу «json: unknown field ...».
    stubFetch(
      new Response('{"error":{"code":"internal","message":"internal server error"}}', {
        status: 500,
      }),
    )
    const out = await submitAnswers('abc', body)
    expect(out).toEqual({
      status: 'rejected',
      message: 'Не удалось отправить — попробуйте ещё раз через минуту.',
    })
  })

  it('чужое тело не-2xx → исключение (сеть/прокси, ретраит вызывающий)', async () => {
    stubFetch(new Response('<html>502</html>', { status: 502 }))
    await expect(submitAnswers('abc', body)).rejects.toThrow()
  })
})
