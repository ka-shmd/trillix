import { describe, expect, it } from 'vitest'

import { formFunnelSchema } from './funnel'

// Фикстура снята РЕАЛЬНЫМ ответом сервера с dev-контура (curl на
// GET /api/v1/forms/{id}/funnel), а не выдумана: выдуманная проверяла бы схему саму
// против себя и разошлась бы с Go-DTO молча.
const realResponse = {
  visits: 4,
  submitted: 1,
  leftBeforeFirst: 2,
  steps: [
    {
      blockId: 'blk_2312e361-a9de-47d8-9269-f8c3f5856861',
      label: 'пишу какой-то вопрос',
      reached: 2,
      droppedHere: 0,
    },
    {
      blockId: 'blk_db910474-f77f-42a8-929f-7abae4ecb0db',
      label: '(без названия) blk_db910474-f77f-42a8-929f-7abae4ecb0db',
      reached: 1,
      droppedHere: 0,
    },
    {
      blockId: 'blk_6dda4c84-3f91-430e-ad56-9f45bcb0f42e',
      label: '(без названия) blk_6dda4c84-3f91-430e-ad56-9f45bcb0f42e',
      reached: 1,
      droppedHere: 0,
    },
    {
      blockId: 'blk_0d92eac2-7112-46b8-8134-3669fab80e49',
      label: 'пишу еще какой-то вопрос',
      reached: 1,
      droppedHere: 1,
    },
  ],
}

describe('formFunnelSchema', () => {
  it('разбирает реальный ответ сервера', () => {
    const parsed = formFunnelSchema.parse(realResponse)
    expect(parsed.visits).toBe(4)
    expect(parsed.steps).toHaveLength(4)
  })

  // Инвариант воронки: она сужается. Если Reached вырастет на каком-то шаге, значит
  // сервер посчитал «дошёл» неверно — экран нарисует расширяющуюся воронку.
  it('на реальных данных Reached не растёт по шагам', () => {
    const { steps } = formFunnelSchema.parse(realResponse)
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.reached).toBeLessThanOrEqual(steps[i - 1]!.reached)
    }
  })

  // Тот самый случай, ради которого GROUP BY идёт и по submitted: визит, отправивший
  // форму, остановился на ПЕРВОМ вопросе (его коснулись последним), но отвалом там
  // не считается. Если бы считался, droppedHere первого шага был бы 1.
  it('отправивший не попадает в отвал на своём последнем поле', () => {
    const { steps } = formFunnelSchema.parse(realResponse)
    expect(steps[0]!.reached).toBe(2)
    expect(steps[0]!.droppedHere).toBe(0)
  })

  // Форма без визитов: пустые шаги — законный ответ, а не повод для ошибки разбора.
  it('принимает пустую воронку', () => {
    const parsed = formFunnelSchema.parse({
      visits: 0,
      submitted: 0,
      leftBeforeFirst: 0,
      steps: [],
    })
    expect(parsed.steps).toEqual([])
  })

  it('отвергает ответ без обязательного поля', () => {
    expect(() => formFunnelSchema.parse({ visits: 1, submitted: 0, steps: [] })).toThrow()
  })
})
