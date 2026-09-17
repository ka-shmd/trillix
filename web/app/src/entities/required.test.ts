import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'
import { isEmptyAnswer, missingRequired } from '@fields/required'

const field = (id: string, type: Block['type'] = 'short_text'): Block => ({ id, groupId: '', type })

describe('missingRequired — доступность кнопки отправки', () => {
  const blocks = [field('a'), field('b', 'multi_choice'), field('t', 'text')]

  it('пустые строка, массив и отсутствие ответа — пусто', () => {
    expect(isEmptyAnswer(undefined)).toBe(true)
    expect(isEmptyAnswer('')).toBe(true)
    expect(isEmptyAnswer([])).toBe(true)
    expect(isEmptyAnswer('0')).toBe(false)
  })

  it('держит кнопку только ФАКТИЧЕСКИ обязательное из плана', () => {
    // Скрытый условием вопрос в видимые блоки не попадает и кнопку не держит.
    expect(missingRequired(blocks, {}, new Set())).toBe(false)
    expect(missingRequired(blocks, {}, new Set(['a']))).toBe(true)
    expect(missingRequired(blocks, { a: 'Анна' }, new Set(['a']))).toBe(false)
    expect(missingRequired(blocks, { a: 'Анна', b: [] }, new Set(['a', 'b']))).toBe(true)
    expect(missingRequired([field('a')], {}, new Set(['hidden']))).toBe(false)
  })
})
