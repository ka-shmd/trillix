import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createVisitTracker } from './visits'

// Тело последнего бикона: sendBeacon получает Blob, читаем его как текст.
async function lastBody(mock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  const blob = mock.mock.calls.at(-1)?.[1] as Blob
  return JSON.parse(await blob.text()) as Record<string, unknown>
}

describe('createVisitTracker', () => {
  let sendBeacon: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sendBeacon = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', { sendBeacon })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('шлёт бикон открытия без блока — «открыл, но ничего не тронул»', async () => {
    createVisitTracker('abc', 'tok', 2, '').start()

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(sendBeacon.mock.calls[0]?.[0]).toBe('/public/v1/forms/abc/visits')
    const body = await lastBody(sendBeacon)
    expect(body.last_block_id).toBeNull()
    expect(body.seq).toBe(0)
    expect(body.version).toBe(2)
    expect(body.token).toBe('tok')
  })

  // Ради seq заведена колонка в БД: доставка биконов не упорядочена, и сервер
  // выбирает «докуда дошёл» по номеру, а не по времени прихода.
  it('нумерует биконы одного визита по возрастанию', async () => {
    const tracker = createVisitTracker('abc', 'tok', 1, '')
    tracker.start()
    tracker.leave('b1')
    tracker.leave('b2')

    const seqs = await Promise.all(
      sendBeacon.mock.calls.map(async (_, i) => {
        const blob = sendBeacon.mock.calls[i]?.[1] as Blob
        return (JSON.parse(await blob.text()) as { seq: number }).seq
      }),
    )
    expect(seqs).toEqual([0, 1, 2])
  })

  it('шлёт один и тот же visit_id во всех биконах визита', async () => {
    const tracker = createVisitTracker('abc', 'tok', 1, '')
    tracker.start()
    tracker.leave('b1')

    const first = (JSON.parse(await (sendBeacon.mock.calls[0]?.[1] as Blob).text()) as { visit_id: string })
      .visit_id
    const second = await lastBody(sendBeacon)
    expect(second.visit_id).toBe(first)
    expect(tracker.id).toBe(first)
  })

  it('slug экранируется в адресе', () => {
    createVisitTracker('a/b?c', 'tok', 1, '').start()
    expect(sendBeacon.mock.calls[0]?.[0]).toBe('/public/v1/forms/a%2Fb%3Fc/visits')
  })

  it('Content-Type ставится через тип Blob — заголовки sendBeacon передать нельзя', async () => {
    createVisitTracker('abc', 'tok', 1, '').start()
    const blob = sendBeacon.mock.calls[0]?.[1] as Blob
    expect(blob.type).toBe('application/json')
  })
})

describe('метки источника', () => {
  let sendBeacon: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sendBeacon = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', { sendBeacon })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('берёт только известные utm_* из адреса', async () => {
    const search = '?utm_source=telegram&utm_medium=post&fbclid=xxx&id=7'
    createVisitTracker('abc', 'tok', 1, search).start()

    const body = await lastBody(sendBeacon)
    expect(body.utm).toEqual({ utm_source: 'telegram', utm_medium: 'post' })
  })

  it('без меток шлёт пустой объект, а не мусор из адреса', async () => {
    createVisitTracker('abc', 'tok', 1, '?ref=friend').start()

    const body = await lastBody(sendBeacon)
    expect(body.utm).toEqual({})
  })
})
