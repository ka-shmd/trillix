import { describe, expect, it, vi } from 'vitest'

import { createHostBridge, type HostMessage } from './embed'
import {
  GOAL_OPEN,
  GOAL_START,
  GOAL_SUBMIT,
  goalSink,
  type MetrikaHost,
  startMetrika,
  TAG_SRC,
} from './metrika'

function fakeHost(): MetrikaHost & { appendScript: ReturnType<typeof vi.fn> } {
  return { win: {}, appendScript: vi.fn<(src: string) => void>() }
}

// Вызовы, накопленные очередью `ym` до загрузки tag.js, — ровно то, что счётчик
// разберёт, когда загрузится.
function queued(host: MetrikaHost): unknown[][] {
  return host.win.ym?.a ?? []
}

function fakeBridge() {
  const sent: HostMessage[] = []
  return { sent, bridge: createHostBridge('block', (m) => sent.push(m)) }
}

const page = { preview: false, framed: false, bridge: null }

describe('goalSink', () => {
  it('на обычной странице запускает счётчик автора', () => {
    const host = fakeHost()
    expect(goalSink('12345678', page, host)).not.toBeNull()
    expect(host.appendScript).toHaveBeenCalledWith(TAG_SRC)
  })

  it('без номера целей нет', () => {
    const host = fakeHost()
    expect(goalSink(null, page, host)).toBeNull()
    expect(host.appendScript).not.toHaveBeenCalled()
  })

  it('в предпросмотре автора целей нет — ни на странице, ни во фрейме', () => {
    const host = fakeHost()
    const { sent, bridge } = fakeBridge()
    expect(goalSink('12345678', { ...page, preview: true }, host)).toBeNull()
    expect(goalSink('12345678', { preview: true, framed: true, bridge }, host)).toBeNull()
    expect(host.appendScript).not.toHaveBeenCalled()
    expect(sent.map((m) => m.type)).toEqual(['ready'])
  })

  it('во фрейме цели уходят хосту, а скрипт Метрики не грузится', () => {
    const host = fakeHost()
    const { sent, bridge } = fakeBridge()
    const goals = goalSink('12345678', { preview: false, framed: true, bridge }, host)

    goals?.reach(GOAL_OPEN)
    goals?.reach(GOAL_START)
    goals?.reach(GOAL_START)
    goals?.reach(GOAL_SUBMIT)

    expect(host.appendScript).not.toHaveBeenCalled()
    expect(host.win.ym).toBeUndefined()
    expect(sent.filter((m) => m.type === 'goal')).toEqual([
      { source: 'trillix', v: 1, type: 'goal', counter: 12345678, name: 'trillix_open' },
      { source: 'trillix', v: 1, type: 'goal', counter: 12345678, name: 'trillix_start' },
      { source: 'trillix', v: 1, type: 'goal', counter: 12345678, name: 'trillix_submit' },
    ])
  })

  it('фрейм без загрузчика (голый iframe) — целей нет: принимать некому', () => {
    const host = fakeHost()
    expect(goalSink('12345678', { preview: false, framed: true, bridge: null }, host)).toBeNull()
    expect(host.appendScript).not.toHaveBeenCalled()
  })
})

describe('startMetrika', () => {
  it('грузит tag.js элементом и зовёт init с выключенным вебвизором', () => {
    const host = fakeHost()
    startMetrika('12345678', host)

    expect(host.appendScript).toHaveBeenCalledTimes(1)
    expect(host.appendScript).toHaveBeenCalledWith(TAG_SRC)
    expect(queued(host)).toEqual([
      [
        12345678,
        'init',
        { webvisor: false, clickmap: true, trackLinks: true, accurateTrackBounce: true },
      ],
    ])
    expect(typeof host.win.ym?.l).toBe('number')
  })

  it('цель уходит одним именем, без параметров, и не дважды', () => {
    const host = fakeHost()
    const goals = startMetrika('12345678', host)

    goals.reach(GOAL_OPEN)
    goals.reach(GOAL_START)
    goals.reach(GOAL_START)
    goals.reach(GOAL_SUBMIT)

    expect(queued(host).slice(1)).toEqual([
      [12345678, 'reachGoal', 'trillix_open'],
      [12345678, 'reachGoal', 'trillix_start'],
      [12345678, 'reachGoal', 'trillix_submit'],
    ])
  })

  it('чужую ym на странице не подменяет и второй tag.js не грузит', () => {
    const calls: unknown[][] = []
    const host: MetrikaHost & { appendScript: ReturnType<typeof vi.fn> } = {
      win: { ym: (...args: unknown[]) => void calls.push(args) },
      appendScript: vi.fn<(src: string) => void>(),
    }
    startMetrika('42', host).reach(GOAL_OPEN)

    expect(host.appendScript).not.toHaveBeenCalled()
    expect(calls.map((c) => c[1])).toEqual(['init', 'reachGoal'])
  })
})
