// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { OAUTH_MESSAGE_SOURCE, useOAuthPopup } from './oauthPopup'

// Вход в отдельном окне. Проверяется то, чего не видно глазами: какие сообщения
// вкладка принимает, а какие обязана молча отбросить, и когда закрытое окно
// считается брошенным походом.

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface FakeWindow {
  closed: boolean
  close: () => void
}

let fake: FakeWindow

beforeEach(() => {
  vi.useFakeTimers()
  fake = { closed: false, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(fake as unknown as Window)
  // happy-dom по умолчанию 1024×768, но узкий экран проверяется отдельно.
  window.happyDOM?.setViewport?.({ width: 1280 })
})

// Сообщение приходится собирать руками: source в конструкторе MessageEvent
// принимает только настоящее окно.
function post(data: unknown, origin: string, source: unknown) {
  const event = new MessageEvent('message', { data, origin })
  Object.defineProperty(event, 'source', { value: source })
  act(() => {
    window.dispatchEvent(event)
  })
}

function start() {
  const outcomes: string[] = []
  const view = renderHook(() => useOAuthPopup((o) => outcomes.push(o)))
  act(() => {
    view.result.current.open('/api/v1/auth/oauth/yandex/start?mode=popup')
  })
  return { view, outcomes }
}

describe('useOAuthPopup — что вкладка принимает от окна', () => {
  it('своё сообщение доставляет исход и снимает ожидание', () => {
    const { view, outcomes } = start()
    expect(view.result.current.waiting).toBe(true)

    post({ source: OAUTH_MESSAGE_SOURCE, outcome: 'ok' }, window.location.origin, fake)

    expect(outcomes).toEqual(['ok'])
    expect(view.result.current.waiting).toBe(false)
  })

  it('чужой origin не принимается', () => {
    const { view, outcomes } = start()

    post({ source: OAUTH_MESSAGE_SOURCE, outcome: 'ok' }, 'https://evil.example', fake)

    expect(outcomes).toEqual([])
    expect(view.result.current.waiting).toBe(true)
  })

  it('чужое окно не принимается', () => {
    const { view, outcomes } = start()

    // Origin свой (сообщение из нашего же фрейма или расширения), но окно не то,
    // которое мы открывали.
    post({ source: OAUTH_MESSAGE_SOURCE, outcome: 'ok' }, window.location.origin, {
      closed: false,
    })

    expect(outcomes).toEqual([])
    expect(view.result.current.waiting).toBe(true)
  })

  it('незнакомая форма сообщения и неизвестный код не принимаются', () => {
    const { view, outcomes } = start()

    post({ outcome: 'ok' }, window.location.origin, fake)
    post({ source: OAUTH_MESSAGE_SOURCE, outcome: 'redirect' }, window.location.origin, fake)
    post('ok', window.location.origin, fake)

    expect(outcomes).toEqual([])
    expect(view.result.current.waiting).toBe(true)
  })
})

describe('useOAuthPopup — закрытое окно', () => {
  it('снимает ожидание, когда окно закрыли руками', () => {
    const { view, outcomes } = start()

    fake.closed = true
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(view.result.current.waiting).toBe(false)
    expect(outcomes).toEqual([])
  })

  it('не хоронит поход на первом же тике: исход мог быть отправлен перед закрытием', () => {
    const { view, outcomes } = start()

    // Окно закрылось сразу после postMessage, сообщение ещё в очереди задач.
    fake.closed = true
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(view.result.current.waiting).toBe(true)

    post({ source: OAUTH_MESSAGE_SOURCE, outcome: 'ok' }, window.location.origin, fake)

    expect(outcomes).toEqual(['ok'])
  })
})

describe('useOAuthPopup — когда окна не будет', () => {
  it('блокировщик попапов: open отвечает false и ожидания нет', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const outcomes: string[] = []
    const view = renderHook(() => useOAuthPopup((o) => outcomes.push(o)))

    let opened = true
    act(() => {
      opened = view.result.current.open('/api/v1/auth/oauth/yandex/start?mode=popup')
    })

    // false = вызывающий обязан оставить обычный переход по ссылке.
    expect(opened).toBe(false)
    expect(view.result.current.waiting).toBe(false)
  })

  it('узкий экран: окно не открывается вовсе', () => {
    window.happyDOM?.setViewport?.({ width: 500 })
    const outcomes: string[] = []
    const view = renderHook(() => useOAuthPopup((o) => outcomes.push(o)))

    let opened = true
    act(() => {
      opened = view.result.current.open('/api/v1/auth/oauth/yandex/start?mode=popup')
    })

    expect(opened).toBe(false)
    expect(window.open).not.toHaveBeenCalled()
    expect(view.result.current.waiting).toBe(false)
  })
})
