import { describe, expect, it } from 'vitest'

import { type FormFunnel } from '../../entities/funnel'
import {
  dropPercent,
  droppedPhrase,
  funnelRows,
  type FunnelRow,
  funnelSteps,
  pageQuestionRows,
  percentOf,
  worstStep,
} from './metrics'

function row(label: string, reached: number, dropped: number): FunnelRow {
  return { key: label, label, reached, dropped }
}

const multipage: FormFunnel = {
  visits: 100,
  submitted: 30,
  leftBeforeFirst: 10,
  steps: [
    { blockId: 'q1', label: 'Имя', page: '', reached: 90, droppedHere: 20 },
    { blockId: 'q2', label: 'Телефон', page: 'pb1', reached: 70, droppedHere: 25 },
    { blockId: 'q3', label: 'Адрес', page: 'pb1', reached: 45, droppedHere: 15 },
  ],
  pages: [
    {
      key: '',
      label: 'Страница 1',
      reached: 90,
      droppedHere: 20,
      timeSec: 42,
      timeSamples: 60,
      leftTimeSec: 0,
      leftSamples: 0,
    },
    {
      key: 'pb1',
      label: 'Контакты',
      reached: 70,
      droppedHere: 40,
      timeSec: 0,
      timeSamples: 0,
      leftTimeSec: 95,
      leftSamples: 40,
    },
  ],
}

describe('percentOf', () => {
  it('округляет долю', () => {
    expect(percentOf(1, 3)).toBe(33)
    expect(percentOf(2, 3)).toBe(67)
  })

  // Вопрос, которого никто не видел: без этой ветки в ширину полоски уехал бы NaN,
  // и вёрстка сломалась бы молча.
  it('нулевой знаменатель даёт ноль, а не NaN', () => {
    expect(percentOf(0, 0)).toBe(0)
  })
})

describe('funnelRows', () => {
  it('у многостраничной формы шаги — страницы между двумя ступенями', () => {
    expect(funnelRows(multipage).map((r) => r.label)).toEqual([
      'Открыли форму',
      'Страница 1',
      'Контакты',
      'Отправили форму',
    ])
  })

  it('у одностраничной — вопросы с номерами', () => {
    const single = { ...multipage, pages: [] }
    expect(funnelRows(single).map((r) => r.label)).toEqual([
      'Открыли форму',
      '1. Имя',
      '2. Телефон',
      '3. Адрес',
      'Отправили форму',
    ])
  })
})

describe('funnelSteps', () => {
  // Знаменатель 0 — данных нет, и «0 с» на экране было бы неправдой.
  it('берёт время страницы, только если по нему есть данные', () => {
    const [first, second] = funnelSteps(multipage)
    expect(first).toMatchObject({ timeSec: 42 })
    expect(first).not.toHaveProperty('leftTimeSec')
    expect(second).not.toHaveProperty('timeSec')
    expect(second).toMatchObject({ leftTimeSec: 95 })
  })
})

describe('pageQuestionRows', () => {
  // Номер вопроса — позиция во всей форме, а не на странице: тот же, что у
  // одностраничной воронки и в выгрузке.
  it('отдаёт вопросы страницы с номерами во всей форме', () => {
    expect(pageQuestionRows(multipage, 'pb1').map((r) => r.label)).toEqual([
      '2. Телефон',
      '3. Адрес',
    ])
    expect(pageQuestionRows(multipage, '').map((r) => r.label)).toEqual(['1. Имя'])
  })
})

describe('worstStep', () => {
  // По доле, а не по числу: 25 из 50 хуже, чем 30 из 300, хотя ушедших меньше.
  it('называет шаг с наибольшей долей ушедших', () => {
    const worst = worstStep([row('Имя', 300, 30), row('Телефон', 50, 25), row('Адрес', 25, 5)])
    expect(worst).toMatchObject({ label: 'Телефон', dropped: 25, reached: 50, percent: 50 })
  })

  // «Ушли 2 из 2» — это два человека, а не худший шаг.
  it('шаг ниже порога малых выборок худшим не бывает', () => {
    expect(worstStep([row('Имя', 200, 20), row('Телефон', 2, 2)])?.label).toBe('Имя')
    expect(worstStep([row('Телефон', 19, 19)])).toBeNull()
  })

  // Форма, которую все проходят до конца: фраза «чаще всего уходят на шаге X» про
  // нулевой отвал была бы обвинением на пустом месте.
  it('без отвалов отдаёт null', () => {
    expect(worstStep([row('Имя', 30, 0), row('Телефон', 30, 0)])).toBeNull()
    expect(worstStep([])).toBeNull()
  })

  it('при равной доле — больший отвал, при полном равенстве — более ранний шаг', () => {
    expect(worstStep([row('Имя', 20, 10), row('Телефон', 40, 20)])?.label).toBe('Телефон')
    expect(worstStep([row('Имя', 40, 10), row('Телефон', 40, 10)])?.label).toBe('Имя')
  })
})

describe('dropPercent', () => {
  it('доля ушедших только от порога малых выборок', () => {
    expect(dropPercent(row('Имя', 20, 5))).toBe(25)
    expect(dropPercent(row('Имя', 19, 5))).toBeNull()
  })
})

describe('droppedPhrase', () => {
  it('согласует оба глагола по числу', () => {
    expect(droppedPhrase(1)).toBe('1 остановился здесь и дальше не пошёл')
    expect(droppedPhrase(21)).toBe('21 остановился здесь и дальше не пошёл')
    expect(droppedPhrase(5)).toBe('5 остановились здесь и дальше не пошли')
  })

  // 11 — исключение из правила «оканчивается на 1»: одиннадцать остановились.
  it('одиннадцать во множественном числе', () => {
    expect(droppedPhrase(11)).toBe('11 остановились здесь и дальше не пошли')
  })
})
