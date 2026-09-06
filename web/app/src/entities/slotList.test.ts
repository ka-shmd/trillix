import { describe, expect, it } from 'vitest'

import {
  colsFor,
  dayStrip,
  fits,
  fullDayLabel,
  groupByDay,
  monthLabel,
  timeLabel,
  zoneNote,
} from '@fields/slots/slotList'

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

describe('лента дат', () => {
  it('дни без свободного времени остаются в ленте погашенными', () => {
    // Лента КАЛЕНДАРНАЯ: между 10-м и 13-м стоят 11-е и 12-е, просто без времён.
    // Выброси их — и «10, 13» прочтётся как сбой выдачи, а не как «в эти дни не
    // принимают».
    const cells = dayStrip([
      { key: '2026-09-10', slots: [slot('2026-09-10T08:00:00Z')] },
      { key: '2026-09-13', slots: [slot('2026-09-13T08:00:00Z')] },
    ])
    expect(cells.map((c) => c.key)).toEqual([
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ])
    expect(cells.map((c) => c.slots.length)).toEqual([1, 0, 0, 1])
  })

  it('лента начинается с первого СВОБОДНОГО дня', () => {
    const cells = dayStrip([{ key: '2026-10-05', slots: [slot('2026-10-05T08:00:00Z')] }])
    expect(cells).toHaveLength(1)
    expect(cells[0]!.key).toBe('2026-10-05')
  })

  it('пустая выдача даёт пустую ленту', () => {
    expect(dayStrip([])).toEqual([])
  })

  it('квадрат несёт число и день недели', () => {
    const cells = dayStrip([{ key: '2026-09-10', slots: [slot('2026-09-10T08:00:00Z')] }])
    expect(cells[0]!.num).toBe('10')
    // Четверг — по календарю, а не по строке: сокращение даёт локаль.
    expect(cells[0]!.weekday).toBe(
      new Date(2026, 8, 10).toLocaleDateString('ru-RU', { weekday: 'short' }),
    )
  })
})

describe('подпись месяца над лентой', () => {
  const strip = (from: string, to: string) =>
    dayStrip([
      { key: from, slots: [] },
      { key: to, slots: [] },
    ])

  it('окно внутри месяца называет один месяц с годом', () => {
    expect(monthLabel(strip('2026-09-10', '2026-09-16'))).toBe('сентябрь 2026')
  })

  it('окно через границу месяца называет оба', () => {
    expect(monthLabel(strip('2026-09-28', '2026-10-02'))).toBe('сентябрь — октябрь 2026')
  })

  it('окно через границу года называет год у каждого месяца', () => {
    expect(monthLabel(strip('2026-12-30', '2027-01-02'))).toBe('декабрь 2026 — январь 2027')
  })

  it('пустое окно не подписывается', () => {
    expect(monthLabel([])).toBe('')
  })
})

describe('заголовок над сеткой времён', () => {
  it('называет день полным именем', () => {
    const cells = dayStrip([{ key: '2026-09-10', slots: [] }])
    expect(fullDayLabel(cells[0]!)).toBe(
      new Date(2026, 8, 10).toLocaleDateString('ru-RU', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }),
    )
  })
})

describe('сколько квадратов влезает в ленту', () => {
  it('на широкой колонке дней больше, чем на узкой', () => {
    expect(colsFor(700)).toBeGreaterThan(colsFor(360))
  })

  it('узкая колонка всё равно показывает неделю', () => {
    // Пол в семь дней: на телефоне квадраты ужимаются, но неделя видна целиком —
    // лента из четырёх дней заставляла бы листать ради завтра.
    expect(colsFor(320)).toBe(7)
    expect(colsFor(120)).toBe(7)
  })

  it('очень широкая колонка не разворачивается в месяц', () => {
    expect(colsFor(4000)).toBe(14)
  })

  it('ширина, которой ещё нет, даёт неделю', () => {
    // До первого замера (и там, где ResizeObserver нет вовсе) лента показывает неделю.
    expect(colsFor(0)).toBe(7)
  })
})
