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
    expect(unlockToken('store-1')).toBe('')
    rememberUnlock('store-1', 'tok-a')
    expect(unlockToken('store-1')).toBe('tok-a')
    // Токен одной формы не выдаётся за другую: у каждой свой ключ.
    expect(unlockToken('store-2')).toBe('')
  })

  it('без токена заголовка нет вовсе — запрос открытой формы не меняется', () => {
    expect(unlockHeaders('store-3')).toEqual({})
    rememberUnlock('store-3', 'tok-a')
    expect(unlockHeaders('store-3')).toEqual({ 'X-Form-Unlock': 'tok-a' })
  })

  // Хранилище может быть недоступно вовсе: приватный режим, запрет хранения третьей
  // стороне у встроенной формы. Разблокировка обязана работать до перезагрузки
  // страницы — иначе верный пароль принимается, токен теряется, и форму в таком
  // браузере нельзя открыть ВООБЩЕ.
  it('отказ sessionStorage не теряет токен в этой загрузке страницы', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
      removeItem: () => undefined,
    })
    stubFetch(new Response(JSON.stringify({ token: 'tok', expiresIn: 86400 }), { status: 200 }))

    expect(await unlockForm('no-storage', 'секрет')).toEqual({ status: 'ok' })
    expect(unlockToken('no-storage')).toBe('tok')
    expect(unlockHeaders('no-storage')).toEqual({ 'X-Form-Unlock': 'tok' })
  })
})

describe('unlockForm', () => {
  it('верный пароль → токен сохранён', async () => {
    stubFetch(new Response(JSON.stringify({ token: 'tok', expiresIn: 86400 }), { status: 200 }))
    expect(await unlockForm('unlock-ok', 'секрет')).toEqual({ status: 'ok' })
    expect(unlockToken('unlock-ok')).toBe('tok')
  })

  it('401 → wrong, токен не сохраняется', async () => {
    stubFetch(new Response(null, { status: 401 }))
    expect(await unlockForm('unlock-wrong', 'не тот')).toEqual({ status: 'wrong' })
    expect(unlockToken('unlock-wrong')).toBe('')
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
    await submitAnswers('abc', { submissionId: 's', token: 't', answers: {}, visitId: 'v', consentRevision: '' })
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
    const r = await submitAnswers('abc', { submissionId: 's', token: 't', answers: {}, visitId: 'v', consentRevision: '' })
    expect(r.status).toBe('rejected')
  })
})
