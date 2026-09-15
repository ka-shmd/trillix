import { describe, expect, it, vi } from 'vitest'

import {
  GOAL_OPEN,
  GOAL_START,
  GOAL_SUBMIT,
  metrikaCounter,
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

describe('metrikaCounter', () => {
  it('запускает счётчик только на обычной странице с номером', () => {
    expect(metrikaCounter('12345678', { preview: false, framed: false })).toBe('12345678')
    expect(metrikaCounter(null, { preview: false, framed: false })).toBeNull()
  })

  it('в предпросмотре автора счётчика нет', () => {
    expect(metrikaCounter('12345678', { preview: true, framed: false })).toBeNull()
  })

  it('во фрейме счётчика нет — цели там отмечает счётчик сайта-хозяина', () => {
    expect(metrikaCounter('12345678', { preview: false, framed: true })).toBeNull()
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
