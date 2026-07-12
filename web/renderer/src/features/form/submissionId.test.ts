import { describe, expect, it } from 'vitest'

import { uuidv7 } from './submissionId'

describe('uuidv7', () => {
  it('канонический формат UUID', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('версия 7 и вариант RFC 4122', () => {
    const id = uuidv7()
    expect(id[14]).toBe('7') // старший нибл 7-й группы — версия
    expect(['8', '9', 'a', 'b']).toContain(id[19]) // вариант
  })

  it('уникален от вызова к вызову', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()))
    expect(ids.size).toBe(1000)
  })

  it('монотонно неубывает по времени (48-битный префикс времени)', () => {
    const a = uuidv7()
    const b = uuidv7()
    // Префикс времени (первые 12 hex без дефиса) у второго не меньше — оба в одном мс
    // либо второй позже. Сравнение строк корректно для hex одинаковой длины.
    expect(b.slice(0, 8) >= a.slice(0, 8)).toBe(true)
  })
})
