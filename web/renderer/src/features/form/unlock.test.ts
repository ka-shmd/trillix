import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchPublicForm, savePartial, submitAnswers } from './api'
import { rememberUnlock, unlockForm, unlockHeaders, unlockToken } from './unlock'

function stubFetch(response: Response) {
  const spy = vi.fn((url: string, init?: RequestInit) => {
    void url
    void init
    return Promise.resolve(response)
  })
  vi.stubGlobal('fetch', spy)
  // initOf достаёт init первого вызова: типизировать мок как fetch целиком дороже,
  // чем назвать здесь ровно то, что проверяют тесты, — заголовки и тело запроса.
  return (call = 0): RequestInit => spy.mock.calls[call]?.[1] ?? {}
}

// Тесты рендерера идут на node (happy-dom тут нет — он в кабинете), поэтому
// sessionStorage подставляем сами. Нужны ровно три метода, которые зовёт модуль.
function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('хранилище токена', () => {
  it('токен живёт на вкладке и раздаётся по slug', () => {
    expect(unlockToken('a')).toBe('')
    rememberUnlock('a', 'tok-a')
    expect(unlockToken('a')).toBe('tok-a')
    // Токен одной формы не выдаётся за другую: у каждой свой ключ.
    expect(unlockToken('b')).toBe('')
  })

  it('без токена заголовка нет вовсе — запрос открытой формы не меняется', () => {
    expect(unlockHeaders('a')).toEqual({})
    rememberUnlock('a', 'tok-a')
    expect(unlockHeaders('a')).toEqual({ 'X-Form-Unlock': 'tok-a' })
  })
})

describe('unlockForm', () => {
  it('верный пароль → токен сохранён', async () => {
    stubFetch(new Response(JSON.stringify({ token: 'tok', expiresIn: 86400 }), { status: 200 }))
    expect(await unlockForm('abc', 'секрет')).toEqual({ status: 'ok' })
    expect(unlockToken('abc')).toBe('tok')
  })

  it('401 → wrong, токен не сохраняется', async () => {
    stubFetch(new Response(null, { status: 401 }))
    expect(await unlockForm('abc', 'не тот')).toEqual({ status: 'wrong' })
    expect(unlockToken('abc')).toBe('')
  })

  it('429 → limited (попытки исчерпаны), отдельно от неверного пароля', async () => {
    stubFetch(new Response(null, { status: 429 }))
    expect(await unlockForm('abc', 'секрет')).toEqual({ status: 'limited' })
  })
})

describe('токен едет со всеми запросами формы', () => {
  it('401 у формы → locked с названием и без схемы', async () => {
    stubFetch(
      new Response(JSON.stringify({ locked: true, title: 'Опрос про доставку', showBadge: true }), {
        status: 401,
      }),
    )
    const r = await fetchPublicForm('abc')
    expect(r.status).toBe('locked')
    if (r.status === 'locked') expect(r.title).toBe('Опрос про доставку')
    expect(Object.keys(r)).not.toContain('form')
  })

  it('загрузка формы предъявляет токен заголовком', async () => {
    rememberUnlock('abc', 'tok')
    const init = stubFetch(new Response(null, { status: 404 }))
    await fetchPublicForm('abc')
    expect((init().headers as Record<string, string>)['X-Form-Unlock']).toBe('tok')
  })

  it('отправка ответа предъявляет токен заголовком', async () => {
    rememberUnlock('abc', 'tok')
    const init = stubFetch(new Response(null, { status: 201 }))
    await submitAnswers('abc', { submissionId: 's', token: 't', answers: {}, visitId: 'v' })
    expect((init().headers as Record<string, string>)['X-Form-Unlock']).toBe('tok')
  })

  // У черновика токен едет В ТЕЛЕ: последнее сохранение уходит через sendBeacon,
  // который заголовков не умеет вовсе.
  it('автосохранение черновика кладёт токен в тело', () => {
    rememberUnlock('abc', 'tok')
    const init = stubFetch(new Response(null, { status: 204 }))
    savePartial('abc', { visit_id: 'v', token: 't', version: 1, answers: {}, last_block_id: null })
    expect(JSON.parse(init().body as string).unlock).toBe('tok')
  })

  // Форма заперлась, пока её заполняли: ответ отвергнут внятным текстом, а не
  // «принято» и не пятисоткой.
  it('401 у отправки → осмысленный отказ', async () => {
    stubFetch(new Response(null, { status: 401 }))
    const r = await submitAnswers('abc', { submissionId: 's', token: 't', answers: {}, visitId: 'v' })
    expect(r.status).toBe('rejected')
  })
})
