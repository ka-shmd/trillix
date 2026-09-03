import { describe, expect, it } from 'vitest'

import { DEFAULT_SCHEDULE, type Availability } from '../../entities/schedule'
import {
  addWindow,
  availabilityError,
  clockToMinutes,
  copyToWorkdays,
  dayEnabled,
  removeWindow,
  setWindow,
  toggleDay,
  weekSummary,
  windowsError,
} from './weekly'

const base: Availability = {
  weekly: { mon: [{ from: '10:00', to: '13:00' }] },
  exceptions: [],
}

describe('дни недели', () => {
  it('день без окон выключен, с окнами — включён', () => {
    expect(dayEnabled(base, 'mon')).toBe(true)
    expect(dayEnabled(base, 'sat')).toBe(false)
    expect(dayEnabled(toggleDay(base, 'mon', false), 'mon')).toBe(false)
  })

  it('включение даёт рабочий день, выключение — пустой список, а не удаление ключа', () => {
    const on = toggleDay(base, 'sat', true)
    expect(on.weekly.sat).toEqual([{ from: '10:00', to: '18:00' }])
    expect(toggleDay(on, 'sat', false).weekly.sat).toEqual([])
  })

  it('копирование на будни повторяет окна и не трогает выходные', () => {
    const withSat = toggleDay(base, 'sat', true)
    const copied = copyToWorkdays(withSat, 'mon')
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) {
      expect(copied.weekly[day]).toEqual([{ from: '10:00', to: '13:00' }])
    }
    expect(copied.weekly.sat).toEqual([{ from: '10:00', to: '18:00' }])
  })

  it('копирование не делит окна ссылкой: правка одного дня не задевает соседей', () => {
    const copied = copyToWorkdays(base, 'mon')
    const edited = setWindow(copied, 'tue', 0, { from: '09:00', to: '12:00' })
    expect(edited.weekly.mon).toEqual([{ from: '10:00', to: '13:00' }])
  })
})

describe('окна', () => {
  it('новое окно встаёт после последнего и годно сразу', () => {
    const next = addWindow(base, 'mon')
    expect(next.weekly.mon).toEqual([
      { from: '10:00', to: '13:00' },
      { from: '14:00', to: '15:00' },
    ])
    expect(windowsError(next.weekly.mon ?? [])).toBeNull()
  })

  it('окно у дня без окон — рабочий день', () => {
    expect(addWindow(base, 'sun').weekly.sun).toEqual([{ from: '10:00', to: '18:00' }])
  })

  it('удаление вынимает нужное окно', () => {
    const two = addWindow(base, 'mon')
    expect(removeWindow(two, 'mon', 0).weekly.mon).toEqual([{ from: '14:00', to: '15:00' }])
  })
})

describe('проверка правила — зеркало сервера', () => {
  it.each([
    ['вывернутое окно', [{ from: '18:00', to: '10:00' }], 'Конец окна должен быть позже начала'],
    ['пустое окно', [{ from: '10:00', to: '10:00' }], 'Конец окна должен быть позже начала'],
    [
      'пересечение',
      [
        { from: '10:00', to: '15:00' },
        { from: '14:00', to: '18:00' },
      ],
      'Окна пересекаются или идут не по порядку',
    ],
    [
      'не по порядку',
      [
        { from: '14:00', to: '18:00' },
        { from: '10:00', to: '13:00' },
      ],
      'Окна пересекаются или идут не по порядку',
    ],
    ['не время', [{ from: '9:00', to: '18:00' }], 'Время указано неверно'],
    ['час за сутками', [{ from: '10:00', to: '25:00' }], 'Время указано неверно'],
  ])('%s', (_name, windows, message) => {
    expect(windowsError(windows)).toBe(message)
  })

  it('окна впритык законны, полночь концом окна — тоже', () => {
    expect(
      windowsError([
        { from: '10:00', to: '13:00' },
        { from: '13:00', to: '18:00' },
      ]),
    ).toBeNull()
    expect(windowsError([{ from: '22:00', to: '24:00' }])).toBeNull()
  })

  it('умолчания нового расписания проходят проверку', () => {
    expect(availabilityError(DEFAULT_SCHEDULE.availability)).toBeNull()
  })

  it('беда правила называет день', () => {
    const broken = setWindow(base, 'mon', 0, { from: '18:00', to: '10:00' })
    expect(availabilityError(broken)).toEqual({
      day: 'mon',
      message: 'Конец окна должен быть позже начала',
    })
  })
})

describe('разбор времени', () => {
  it.each([
    ['00:00', 0],
    ['10:30', 630],
    ['24:00', 1440],
  ])('%s → %i', (value, minutes) => {
    expect(clockToMinutes(value)).toBe(minutes)
  })

  it.each(['9:00', '10:60', '25:00', '24:30', 'утро', ''])('%s не время', (value) => {
    expect(clockToMinutes(value)).toBeNull()
  })
})

describe('правило одной строкой', () => {
  it('подряд идущие одинаковые дни сворачиваются в диапазон', () => {
    expect(weekSummary(DEFAULT_SCHEDULE.availability)).toBe('пн–пт, 10:00–18:00')
  })

  it('день с перерывом показывает оба окна', () => {
    expect(
      weekSummary({
        weekly: {
          mon: [
            { from: '10:00', to: '13:00' },
            { from: '14:00', to: '18:00' },
          ],
        },
        exceptions: [],
      }),
    ).toBe('пн, 10:00–13:00, 14:00–18:00')
  })

  it('дни через один не сливаются, даже если часы совпадают', () => {
    expect(
      weekSummary({
        weekly: { mon: [{ from: '10:00', to: '12:00' }], wed: [{ from: '10:00', to: '12:00' }] },
        exceptions: [],
      }),
    ).toBe('пн, 10:00–12:00 · ср, 10:00–12:00')
  })

  it('пустое правило говорит об этом словами', () => {
    expect(weekSummary({ weekly: {}, exceptions: [] })).toBe('Приём не ведётся')
  })
})
