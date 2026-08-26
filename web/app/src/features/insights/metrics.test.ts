import { describe, expect, it } from 'vitest'

import { type FunnelStep } from '../../entities/funnel'
import { droppedPhrase, percentOf, worstStep } from './metrics'

function step(label: string, reached: number, droppedHere: number): FunnelStep {
  return { blockId: label, label, reached, droppedHere }
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

describe('worstStep', () => {
  it('называет шаг с наибольшим отвалом и его номер', () => {
    const worst = worstStep([step('Имя', 100, 3), step('Телефон', 90, 40), step('Адрес', 50, 5)])
    expect(worst).toEqual({ label: '2. Телефон', dropped: 40 })
  })

  // Форма, которую все проходят до конца: фраза «больше всего теряется на шаге X»
  // про нулевой отвал была бы обвинением на пустом месте.
  it('без отвалов отдаёт null', () => {
    expect(worstStep([step('Имя', 10, 0), step('Телефон', 10, 0)])).toBeNull()
    expect(worstStep([])).toBeNull()
  })

  // При равенстве побеждает ПЕРВЫЙ: люди уходят раньше по порядку, и обвинять
  // поздний вопрос при той же потере не за что.
  it('при равном отвале берёт более ранний шаг', () => {
    expect(worstStep([step('Имя', 10, 4), step('Телефон', 6, 4)])?.label).toBe('1. Имя')
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
