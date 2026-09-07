import { describe, expect, it } from 'vitest'

import { bookingTime, pluralBookings, zoneShort } from './scheduleFormat'

describe('показ времени расписания', () => {
  // Время автора — время РАСПИСАНИЯ, а не устройства (zone.ts). Сторож именно на
  // это: один и тот же момент в двух поясах обязан читаться разными часами, иначе
  // поездка автора сдвинет ему показ собственного расписания.
  it('момент показывается в поясе расписания, а не браузера', () => {
    const at = '2026-09-09T07:00:00Z'
    expect(bookingTime(at, 'Europe/Moscow')).toContain('10:00')
    expect(bookingTime(at, 'Asia/Vladivostok')).toContain('17:00')
  })

  it('месяц пишется по-русски', () => {
    expect(bookingTime('2026-09-09T07:00:00Z', 'Europe/Moscow')).toContain('сент')
  })

  // Битую строку показывать нечем, но и падать на ней экрану незачем: в списке она
  // означала бы белую страницу вместо всех расписаний сразу.
  it('неразбираемое время даёт прочерк, а не бросок', () => {
    expect(bookingTime('не время', 'Europe/Moscow')).toBe('—')
  })
})

describe('город пояса', () => {
  it('известная зона показывается городом без смещения', () => {
    expect(zoneShort('Europe/Moscow')).toBe('Москва')
    expect(zoneShort('Asia/Yekaterinburg')).toBe('Екатеринбург')
  })

  // Подменить незнакомую зону ближайшим городом значило бы назвать чужое время
  // своим: она показывается идентификатором — так же, как в поле выбора.
  it('незнакомая зона остаётся идентификатором', () => {
    expect(zoneShort('America/New_York')).toBe('America/New_York')
  })
})

describe('склонение записей', () => {
  it('считает по последним двум разрядам', () => {
    expect(pluralBookings(1)).toBe('запись')
    expect(pluralBookings(3)).toBe('записи')
    expect(pluralBookings(5)).toBe('записей')
    expect(pluralBookings(11)).toBe('записей')
    expect(pluralBookings(21)).toBe('запись')
    expect(pluralBookings(112)).toBe('записей')
  })
})
