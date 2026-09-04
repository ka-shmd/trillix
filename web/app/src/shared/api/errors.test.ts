import { describe, expect, it } from 'vitest'

import { ApiError, humanError } from './errors'

// В интерфейсе только русский текст, написанный нами. Бэк пишет человеческое
// сообщение лишь у «обёрнутых» отказов; у остальных message равен коду и приходит
// латиницей — на экран такое попадать не должно (поймано на отмене записи, где
// отказ показался словом «unauthorized»).
describe('текст отказа для человека', () => {
  it('человеческое сообщение бэка показывается как есть', () => {
    const err = new ApiError(422, 'validation_failed', 'Конец окна должен быть позже начала')
    expect(humanError(err)).toBe('Конец окна должен быть позже начала')
  })

  it('код вместо сообщения заменяется нашим текстом', () => {
    expect(humanError(new ApiError(401, 'unauthorized', 'unauthorized'))).toBe(
      'Сессия истекла — войдите заново.',
    )
    expect(humanError(new ApiError(404, 'not_found', 'not_found'))).toBe(
      'Не найдено — возможно, это уже удалили.',
    )
    expect(humanError(new ApiError(403, 'forbidden', 'forbidden'))).toBe(
      'Недостаточно прав для этого действия.',
    )
  })

  it('незнакомый код латиницей падает в общий текст, а не показывается', () => {
    expect(humanError(new ApiError(500, 'internal', 'internal'))).toBe(
      'Что-то пошло не так. Попробуйте ещё раз.',
    )
  })

  it('ошибка не от API наружу не идёт', () => {
    expect(humanError(new TypeError('Failed to fetch'))).toBe(
      'Что-то пошло не так. Попробуйте ещё раз.',
    )
    expect(humanError(new TypeError('Failed to fetch'), 'Свой текст')).toBe('Свой текст')
  })
})
