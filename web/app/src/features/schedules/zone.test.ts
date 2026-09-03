import { describe, expect, it } from 'vitest'

import { zonedToUTC } from './zone'

describe('zonedToUTC', () => {
  it('переводит время расписания в точку на оси времени', () => {
    // 10:00 МСК = 07:00 UTC, независимо от пояса машины, где идёт тест.
    expect(zonedToUTC('2026-09-14', '10:00', 'Europe/Moscow')).toBe('2026-09-14T07:00:00.000Z')
  })

  it('знает про летнее время', () => {
    // Берлин: летом +2, зимой +1 — постоянного смещения у пояса нет.
    expect(zonedToUTC('2026-07-01', '12:00', 'Europe/Berlin')).toBe('2026-07-01T10:00:00.000Z')
    expect(zonedToUTC('2026-01-15', '12:00', 'Europe/Berlin')).toBe('2026-01-15T11:00:00.000Z')
  })

  it('считает верно в самый день перевода часов', () => {
    // Перевод в Берлине 25 октября 2026: 03:00 → 02:00. Вечер этого дня уже зимний.
    expect(zonedToUTC('2026-10-25', '20:00', 'Europe/Berlin')).toBe('2026-10-25T19:00:00.000Z')
    // А утро — ещё летнее.
    expect(zonedToUTC('2026-10-25', '01:00', 'Europe/Berlin')).toBe('2026-10-24T23:00:00.000Z')
  })

  it('пояса западнее Гринвича не путает со знаком', () => {
    expect(zonedToUTC('2026-09-14', '09:00', 'America/New_York')).toBe('2026-09-14T13:00:00.000Z')
  })

  it('мусор на вводе даёт пустую строку, а не Invalid Date', () => {
    expect(zonedToUTC('', '10:00', 'Europe/Moscow')).toBe('')
    expect(zonedToUTC('2026-09-14', '', 'Europe/Moscow')).toBe('')
  })
})
