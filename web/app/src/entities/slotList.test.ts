import { describe, expect, it } from 'vitest'

import { fits, groupByDay, timeLabel, zoneNote } from '@fields/slots/slotList'

// Чистая часть пикера времени (фаза 27). Тест живёт в кабинете: у web/shared своего
// vitest нет — то же место, где проверяются ряды вариантов.
//
// Время в ожиданиях считается от МЕСТНОГО пояса машины, на которой идёт тест: сутки
// режутся по календарю читателя, и жёсткое «11:00» падало бы в CI с другим TZ.
const local = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

const slot = (startsAt: string, remaining = 1) => ({ startsAt, remaining })

describe('группировка свободного времени по дням', () => {
  it('точки одного дня складываются в одну группу', () => {
    const days = groupByDay([slot('2026-09-10T07:00:00Z'), slot('2026-09-10T08:00:00Z')])
    expect(days).toHaveLength(1)
    expect(days[0]!.slots).toHaveLength(2)
  })

  it('дни идут по возрастанию, а времена внутри дня — тоже', () => {
    const days = groupByDay([
      slot('2026-09-11T09:00:00Z'),
      slot('2026-09-10T08:00:00Z'),
      slot('2026-09-11T07:00:00Z'),
    ])
    expect(days.map((d) => d.key)).toEqual([...days.map((d) => d.key)].sort())
    expect(days[days.length - 1]!.slots.map((s) => s.startsAt)).toEqual(
      [...days[days.length - 1]!.slots.map((s) => s.startsAt)].sort(),
    )
  })

  it('сутки режутся по календарю ЧИТАТЕЛЯ, а не по UTC', () => {
    // Ключ дня строится из местных полей даты — иначе вечерние точки уезжали бы в
    // следующий день у всех, кто восточнее Гринвича.
    const at = new Date('2026-09-10T21:30:00Z')
    const days = groupByDay([slot('2026-09-10T21:30:00Z')])
    const expected = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    expect(days[0]!.key).toBe(expected)
  })

  it('битую точку выбрасывает, а не роняет весь список', () => {
    const days = groupByDay([slot('не время'), slot('2026-09-10T08:00:00Z')])
    expect(days).toHaveLength(1)
  })

  it('пустая выдача даёт пустой список дней', () => {
    expect(groupByDay([])).toEqual([])
  })
})

describe('подписи', () => {
  it('время показывается в поясе читателя', () => {
    expect(timeLabel('2026-09-10T08:00:00Z')).toBe(local('2026-09-10T08:00:00Z'))
  })

  it('совпадающий пояс расписания не подписывается', () => {
    expect(zoneNote('Europe/Moscow', 'Europe/Moscow')).toBeNull()
    expect(zoneNote('', 'Europe/Moscow')).toBeNull()
  })

  it('чужой пояс расписания подписывается поясом ЧИТАТЕЛЯ', () => {
    expect(zoneNote('Asia/Vladivostok', 'Europe/Moscow')).toBe(
      'Время указано в вашем часовом поясе (Europe/Moscow)',
    )
  })
})

describe('места', () => {
  it.each([
    [3, 1, true],
    [3, 3, true],
    [2, 3, false],
    [0, 1, false],
  ])('остаток %i, просят %i → %s', (remaining, seats, expected) => {
    expect(fits(slot('2026-09-10T08:00:00Z', remaining), seats)).toBe(expected)
  })
})
