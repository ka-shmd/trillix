import { describe, expect, it } from 'vitest'

import { DEFAULT_SCHEDULE } from '../../entities/schedule'
import { clampSeats, clockToMinutes, weekSummary, windowsError } from './weekly'


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

describe('места в одной записи', () => {
  it.each([
    [3, 8, 3],
    [8, 3, 3],
    [3, 1, 1],
    [0, 5, 1],
  ])('просят %i при вместимости %i → %i', (seats, capacity, expected) => {
    expect(clampSeats(seats, capacity)).toBe(expected)
  })

  // Поле скрыто при вместимости 1, поэтому значение обязано зажиматься само:
  // иначе снижение вместимости оставило бы в документе невыразимое состояние, а
  // сервер отказал бы, показав ошибку у поля, которого на экране уже нет.
  it('снижение вместимости до одного приводит запись к одному месту', () => {
    expect(clampSeats(3, 1)).toBe(1)
  })
})
