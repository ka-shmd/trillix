import { describe, expect, it } from 'vitest'

import type { Availability } from '../../entities/schedule'
import {
  dateKeys,
  effectiveWindows,
  minutesOfNaive,
  shiftDate,
  spansIn,
  weekStart,
  weekdayOf,
} from './canvas'
import { applyGesture, docError } from './canvasEdit'

const base: Availability = {
  weekly: {
    mon: [{ from: '10:00', to: '18:00' }],
    tue: [
      { from: '10:00', to: '13:00' },
      { from: '14:00', to: '18:00' },
    ],
  },
  exceptions: [],
}

describe('слой часов приёма', () => {
  it('день недели считается по календарной дате, а не по поясу браузера', () => {
    expect(weekdayOf('2026-09-16')).toBe('wed')
    expect(weekdayOf('2026-09-14')).toBe('mon')
    expect(weekdayOf('2026-09-13')).toBe('sun')
  })

  // Перевод часов: в ночь на 25 октября 2026 у части поясов сутки длиннее 24 часов.
  // Даты обязаны идти подряд, иначе неделя на полотне теряет или дублирует колонку.
  it('даты идут подряд через перевод часов', () => {
    expect(dateKeys('2026-10-24', 4)).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ])
    expect(shiftDate('2026-10-25', -1)).toBe('2026-10-24')
    expect(weekStart('2026-09-16')).toBe('2026-09-14')
    expect(weekStart('2026-09-14')).toBe('2026-09-14')
  })

  it('исключение перебивает день целиком, а не дополняет его', () => {
    const a: Availability = {
      ...base,
      exceptions: [{ date: '2026-09-15', windows: [{ from: '10:00', to: '12:00' }] }],
    }
    const day = effectiveWindows(a, '2026-09-15')
    expect(day.source).toBe('exception')
    expect(day.windows).toEqual([{ from: '10:00', to: '12:00' }])

    // Пустой список окон — «не принимаю», а не «правило не тронуто».
    const closed: Availability = { ...base, exceptions: [{ date: '2026-09-15', windows: [] }] }
    expect(effectiveWindows(closed, '2026-09-15').windows).toEqual([])
    expect(spansIn(closed, ['2026-09-15'])).toEqual([])
  })

  it('окно до полуночи заканчивается на следующей дате', () => {
    const a: Availability = { weekly: { tue: [{ from: '20:00', to: '24:00' }] }, exceptions: [] }
    const [span] = spansIn(a, ['2026-09-15'])
    expect(span?.start).toBe('2026-09-15T20:00:00')
    expect(span?.end).toBe('2026-09-16T00:00:00')
    expect(minutesOfNaive('2026-09-16T00:00:00', '2026-09-15')).toBe(1440)
  })

  it('источник окна виден полотну', () => {
    const a: Availability = {
      ...base,
      exceptions: [{ date: '2026-09-15', windows: [{ from: '09:00', to: '10:00' }] }],
    }
    const spans = spansIn(a, ['2026-09-14', '2026-09-15'])
    expect(spans.map((s) => s.source)).toEqual(['weekly', 'exception'])
  })
})

describe('жест мышью', () => {
  it('по умолчанию правит недельное правило', () => {
    const next = applyGesture(
      base,
      { kind: 'create', date: '2026-09-16', window: { from: '10:00', to: '14:00' } },
      'weekly',
    )
    expect(next.weekly.wed).toEqual([{ from: '10:00', to: '14:00' }])
    expect(next.exceptions).toEqual([])
    // Соседние дни жест не трогает.
    expect(next.weekly.tue).toEqual(base.weekly.tue)
  })

  it('область «только эта дата» заводит исключение, не трогая правило', () => {
    const next = applyGesture(
      base,
      { kind: 'create', date: '2026-09-15', window: { from: '19:00', to: '20:00' } },
      'date',
    )
    expect(next.weekly.tue).toEqual(base.weekly.tue)
    expect(next.exceptions).toEqual([
      {
        date: '2026-09-15',
        windows: [
          { from: '10:00', to: '13:00' },
          { from: '14:00', to: '18:00' },
          { from: '19:00', to: '20:00' },
        ],
      },
    ])
  })

  // Переключение чипа — это ПЕРЕСЧЁТ ОТ ИСХОДНОГО документа, а не отмена применённого.
  it('щёлканье чипа туда-сюда не накапливает состояния', () => {
    const g = {
      kind: 'create',
      date: '2026-09-15',
      window: { from: '19:00', to: '20:00' },
    } as const
    const byDate = applyGesture(base, g, 'date')
    const byWeekly = applyGesture(base, g, 'weekly')
    expect(applyGesture(base, g, 'date')).toEqual(byDate)
    expect(applyGesture(base, g, 'weekly')).toEqual(byWeekly)
    expect(byWeekly.exceptions).toEqual([])
  })

  it('«каждый вторник» снимает исключение с этой даты', () => {
    const a: Availability = {
      ...base,
      exceptions: [{ date: '2026-09-15', windows: [{ from: '09:00', to: '11:00' }] }],
    }
    const next = applyGesture(
      a,
      {
        kind: 'update',
        date: '2026-09-15',
        orig: { from: '09:00', to: '11:00' },
        window: { from: '09:00', to: '12:00' },
      },
      'weekly',
    )
    expect(next.exceptions).toEqual([])
    // Правилом становится то, что автор ВИДИТ в этой колонке, а не прежнее правило.
    expect(next.weekly.tue).toEqual([{ from: '09:00', to: '12:00' }])
  })

  it('протяжка поверх соседнего окна сливается в одно', () => {
    const next = applyGesture(
      base,
      { kind: 'create', date: '2026-09-15', window: { from: '12:00', to: '15:00' } },
      'weekly',
    )
    expect(next.weekly.tue).toEqual([{ from: '10:00', to: '18:00' }])
    expect(docError(next)).toBeNull()
  })

  it('окна встык склеиваются, а не остаются швом', () => {
    const next = applyGesture(
      base,
      { kind: 'create', date: '2026-09-15', window: { from: '13:00', to: '14:00' } },
      'weekly',
    )
    expect(next.weekly.tue).toEqual([{ from: '10:00', to: '18:00' }])
  })

  it('убирает окно на дате, не трогая остальные', () => {
    const next = applyGesture(
      base,
      { kind: 'remove', date: '2026-09-15', orig: { from: '10:00', to: '13:00' } },
      'weekly',
    )
    expect(next.weekly.tue).toEqual([{ from: '14:00', to: '18:00' }])
  })

  it('убранное последнее окно — это «не принимаю» в этот день', () => {
    const a: Availability = { weekly: { tue: [{ from: '10:00', to: '11:00' }] }, exceptions: [] }
    const next = applyGesture(
      a,
      { kind: 'remove', date: '2026-09-15', orig: { from: '10:00', to: '11:00' } },
      'date',
    )
    expect(next.exceptions).toEqual([{ date: '2026-09-15', windows: [] }])
    expect(next.weekly.tue).toEqual([{ from: '10:00', to: '11:00' }])
  })

  it('переполненный день назван человеческими словами', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      from: `${String(i * 2).padStart(2, '0')}:00`,
      to: `${String(i * 2).padStart(2, '0')}:30`,
    }))
    expect(docError({ weekly: { mon: many }, exceptions: [] })).toContain('12 окон')
  })
})
