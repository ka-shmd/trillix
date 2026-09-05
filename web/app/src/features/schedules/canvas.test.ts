import { describe, expect, it } from 'vitest'

import { DEFAULT_SCHEDULE, type Availability } from '../../entities/schedule'
import {
  dateByNumber,
  dateKeys,
  effectiveWindows,
  bandBox,
  everyLabel,
  onlyLabel,
  selectionRect,
  minutesOfNaive,
  ruleSpans,
  RULE_WEEK_DATES,
  shiftDate,
  spansIn,
  weekStart,
  weekdayOf,
} from './canvas'
import { applyGesture, closeDay, dayState, docError, resetDay, type Gesture } from './canvasEdit'

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
      { kind: 'create', dates: ['2026-09-16'], window: { from: '10:00', to: '14:00' } },
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
      { kind: 'create', dates: ['2026-09-15'], window: { from: '19:00', to: '20:00' } },
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
    const g: Gesture = {
      kind: 'create',
      dates: ['2026-09-15'],
      window: { from: '19:00', to: '20:00' },
    }
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
      { kind: 'create', dates: ['2026-09-15'], window: { from: '12:00', to: '15:00' } },
      'weekly',
    )
    expect(next.weekly.tue).toEqual([{ from: '10:00', to: '18:00' }])
    expect(docError(next)).toBeNull()
  })

  it('окна встык склеиваются, а не остаются швом', () => {
    const next = applyGesture(
      base,
      { kind: 'create', dates: ['2026-09-15'], window: { from: '13:00', to: '14:00' } },
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

  it('умолчания нового расписания проходят проверку', () => {
    expect(docError(DEFAULT_SCHEDULE.availability)).toBeNull()
  })

  it('вывернутое окно названо человеческими словами', () => {
    expect(docError({ weekly: { mon: [{ from: '18:00', to: '10:00' }] }, exceptions: [] })).toBe(
      'Конец окна должен быть позже начала',
    )
  })

  it('переполненный день назван человеческими словами', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      from: `${String(i * 2).padStart(2, '0')}:00`,
      to: `${String(i * 2).padStart(2, '0')}:30`,
    }))
    expect(docError({ weekly: { mon: many }, exceptions: [] })).toContain('12 окон')
  })
})

// ПРОТЯЖКА НА СОСЕДНЮЮ КОЛОНКУ — ПРЯМОУГОЛЬНИК (отчёт владельца 2026-09-04).
// Библиотека отдаёт непрерывный отрезок: «вторник с 10:00 до полуночи, среда целиком,
// четверг до 14:00». Для правила приёма это бессмыслица — оно описывает часы, а не
// одну длинную смену; автор ждёт те же часы на каждом задетом дне.
describe('выделение протяжкой', () => {
  it('внутри одного дня — как нарисовано', () => {
    expect(selectionRect('2026-09-15T10:00:00+03:00', '2026-09-15T14:00:00+03:00')).toEqual({
      dates: ['2026-09-15'],
      window: { from: '10:00', to: '14:00' },
    })
  })

  it('через три дня — те же часы на каждом', () => {
    expect(selectionRect('2026-09-15T10:00:00+03:00', '2026-09-17T14:00:00+03:00')).toEqual({
      dates: ['2026-09-15', '2026-09-16', '2026-09-17'],
      window: { from: '10:00', to: '14:00' },
    })
  })

  // Углы прямоугольника равноправны: протяжка из нижнего в верхний даёт тот же
  // диапазон часов, что и обратная.
  it('часы берутся по краям, а не по порядку', () => {
    expect(selectionRect('2026-09-15T14:00:00+03:00', '2026-09-17T10:00:00+03:00')).toEqual({
      dates: ['2026-09-15', '2026-09-16', '2026-09-17'],
      window: { from: '10:00', to: '14:00' },
    })
  })

  // ⚠ ГРАНИЦА КОНЦА ИСКЛЮЧИТЕЛЬНАЯ: протяжка до низа вторника приезжает как «среда,
  // 00:00». Без поправки она захватила бы лишнюю колонку, а окно «до полуночи» стало
  // бы нулевым.
  it('протяжка до полуночи остаётся одним днём', () => {
    expect(selectionRect('2026-09-15T22:00:00+03:00', '2026-09-16T00:00:00+03:00')).toEqual({
      dates: ['2026-09-15'],
      window: { from: '22:00', to: '24:00' },
    })
  })

  it('протяжка до полуночи через дни закрывает вечер каждого дня', () => {
    expect(selectionRect('2026-09-15T22:00:00+03:00', '2026-09-17T00:00:00+03:00')).toEqual({
      dates: ['2026-09-15', '2026-09-16'],
      window: { from: '22:00', to: '24:00' },
    })
  })

  it('нулевая высота — не выделение', () => {
    expect(selectionRect('2026-09-15T10:00:00+03:00', '2026-09-17T10:00:00+03:00')).toBeNull()
    expect(selectionRect('2026-09-15T10:00:00+03:00', '2026-09-15T10:00:00+03:00')).toBeNull()
  })

  it('прямоугольник кладёт окно на каждый день сразу', () => {
    const next = applyGesture(
      { weekly: {}, exceptions: [] },
      {
        kind: 'create',
        dates: ['2026-09-15', '2026-09-16', '2026-09-17'],
        window: { from: '10:00', to: '14:00' },
      },
      'weekly',
    )
    expect(next.weekly.tue).toEqual([{ from: '10:00', to: '14:00' }])
    expect(next.weekly.wed).toEqual([{ from: '10:00', to: '14:00' }])
    expect(next.weekly.thu).toEqual([{ from: '10:00', to: '14:00' }])
    expect(next.weekly.fri).toBeUndefined()
  })

  it('областью «только эти даты» прямоугольник даёт три исключения', () => {
    const next = applyGesture(
      { weekly: {}, exceptions: [] },
      {
        kind: 'create',
        dates: ['2026-09-15', '2026-09-16'],
        window: { from: '10:00', to: '14:00' },
      },
      'date',
    )
    expect(next.exceptions.map((e) => e.date)).toEqual(['2026-09-15', '2026-09-16'])
    expect(next.weekly).toEqual({})
  })

  it('подписи чипа говорят о нескольких днях, а не об одном', () => {
    expect(everyLabel(['2026-09-15'])).toBe('Каждый вторник')
    expect(everyLabel(['2026-09-15', '2026-09-16', '2026-09-17'])).toBe('Каждые вт, ср, чт')
    expect(onlyLabel(['2026-09-15'])).toBe('Только 15 сентября')
    expect(onlyLabel(['2026-09-15', '2026-09-17'])).toBe('Только 15 — 17 сентября')
  })
})

// Подсказка во время протяжки рисуется поверх чужой геометрии: библиотека
// позиционирует свои слайсы в пикселях inline, и переопределяющее правило читает эти
// два числа. Считаются они от ЗАМЕРЕННОЙ высоты колонки — колонка равна оси часов.
describe('полоса подсказки', () => {
  const axis = { min: '08:00', max: '20:00' } // 12 часов
  const lane = 600 // пикселей на всю ось, то есть 50 на час

  it('окно посреди оси', () => {
    expect(bandBox({ from: '10:00', to: '14:00' }, axis, lane)).toEqual({ top: 100, height: 200 })
  })

  it('окно от самого начала оси', () => {
    expect(bandBox({ from: '08:00', to: '09:00' }, axis, lane)).toEqual({ top: 0, height: 50 })
  })

  it('окно до полуночи считается по «24:00», а не по нулю', () => {
    expect(bandBox({ from: '22:00', to: '24:00' }, { min: '20:00', max: '24:00' }, 200)).toEqual({
      top: 100,
      height: 100,
    })
  })

  it('вывернутое или пустое окно не рисуется', () => {
    expect(bandBox({ from: '14:00', to: '10:00' }, axis, lane)).toBeNull()
    expect(bandBox({ from: '10:00', to: '10:00' }, axis, lane)).toBeNull()
    expect(bandBox({ from: 'полдень', to: '14:00' }, axis, lane)).toBeNull()
  })

  it('пустая ось не делится на ноль', () => {
    expect(bandBox({ from: '10:00', to: '11:00' }, { min: '10:00', max: '10:00' }, lane)).toBeNull()
  })
})

describe('поверхность «Приём» — неделя без дат', () => {
  it('колонки идут с понедельника по воскресенье', () => {
    expect(RULE_WEEK_DATES).toHaveLength(7)
    expect(weekdayOf(RULE_WEEK_DATES[0]!)).toBe('mon')
    expect(weekdayOf(RULE_WEEK_DATES[6]!)).toBe('sun')
  })

  // Сторож мины из canvas.ts: жест области `weekly` снимает исключение со своей даты,
  // и опорная неделя внутри горизонта записи означала бы, что правка правила молча
  // стирает исключения, которых автор в этот момент не видит.
  it('опорная неделя лежит вне горизонта записи', () => {
    const yearsBack = new Date().getUTCFullYear() - Number(RULE_WEEK_DATES[0]!.slice(0, 4))
    expect(yearsBack).toBeGreaterThan(1)
  })

  it('исключения по датам на правило не попадают', () => {
    const withException: Availability = {
      weekly: { mon: [{ from: '10:00', to: '18:00' }] },
      // Исключение ровно на опорный понедельник — самый недобрый случай: попади оно
      // в выдачу, автор правил бы на «Приёме» один день вместо каждого понедельника.
      exceptions: [{ date: RULE_WEEK_DATES[0]!, windows: [{ from: '07:00', to: '08:00' }] }],
    }
    const spans = ruleSpans(withException)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.window).toEqual({ from: '10:00', to: '18:00' })
    expect(spans[0]!.source).toBe('weekly')
  })

  it('правка правила на опорной неделе не трогает исключения настоящих дат', () => {
    const doc: Availability = {
      weekly: { tue: [{ from: '10:00', to: '18:00' }] },
      exceptions: [{ date: '2026-09-16', windows: [{ from: '11:00', to: '12:00' }] }],
    }
    // Вторник опорной недели — тот же день недели, что и 16 сентября 2026.
    const tuesday = RULE_WEEK_DATES[1]!
    const next = applyGesture(
      doc,
      { kind: 'create', dates: [tuesday], window: { from: '09:00', to: '10:00' } },
      'weekly',
    )
    expect(next.weekly.tue).toEqual([{ from: '09:00', to: '18:00' }])
    expect(next.exceptions).toEqual(doc.exceptions)
  })
})

describe('исключения по датам — действия на дне', () => {
  const doc: Availability = {
    weekly: { tue: [{ from: '10:00', to: '18:00' }] },
    exceptions: [],
  }

  it('«не принимаю в этот день» — исключение с пустыми окнами, а не снятое правило', () => {
    const next = closeDay(doc, '2026-09-15')
    expect(next.exceptions).toEqual([{ date: '2026-09-15', windows: [] }])
    // Правило дня недели не тронуто: закрыт ОДИН вторник, а не все.
    expect(next.weekly.tue).toEqual(doc.weekly.tue)
    expect(effectiveWindows(next, '2026-09-15').windows).toEqual([])
    expect(effectiveWindows(next, '2026-09-22').windows).toEqual(doc.weekly.tue)
  })

  it('«принимаю как обычно» возвращает день под недельное правило', () => {
    const closed = closeDay(doc, '2026-09-15')
    expect(resetDay(closed, '2026-09-15').exceptions).toEqual([])
    expect(effectiveWindows(resetDay(closed, '2026-09-15'), '2026-09-15').windows).toEqual(
      doc.weekly.tue,
    )
  })

  it.each([
    ['обычный день', doc, 'weekly'],
    ['закрытый день', closeDay(doc, '2026-09-15'), 'closed'],
    [
      'день со своими часами',
      { ...doc, exceptions: [{ date: '2026-09-15', windows: [{ from: '11:00', to: '12:00' }] }] },
      'exception',
    ],
  ])('%s опознаётся меню', (_name, a, state) => {
    expect(dayState(a as Availability, '2026-09-15')).toBe(state)
  })

  it('закрытый день не теряет закрытия от повторного нажатия', () => {
    const twice = closeDay(closeDay(doc, '2026-09-15'), '2026-09-15')
    expect(twice.exceptions).toEqual([{ date: '2026-09-15', windows: [] }])
  })
})

describe('дата колонки по числу в шапке', () => {
  // Сторож двойного прочтения библиотечного Date: у отрицательного смещения пояса
  // «маркер» и настоящий момент расходятся на сутки, и меню дня закрыло бы соседний.
  const week = dateKeys('2026-09-14', 7)

  it('находит дату по числу месяца', () => {
    expect(dateByNumber(week, '16')).toBe('2026-09-16')
    expect(dateByNumber(week, '20')).toBe('2026-09-20')
  })

  it('через границу месяца число остаётся однозначным', () => {
    const across = dateKeys('2026-09-28', 7)
    expect(dateByNumber(across, '30')).toBe('2026-09-30')
    expect(dateByNumber(across, '1')).toBe('2026-10-01')
  })

  it('чужое число — не дата', () => {
    expect(dateByNumber(week, '31')).toBeUndefined()
    expect(dateByNumber(week, 'вт')).toBeUndefined()
  })
})
