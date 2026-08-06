import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'

import { validateAll, validateBlock } from './validation'

// Хелпер: блок нужного типа с настройками теста.
function block(over: Partial<Block> & Pick<Block, 'type'>): Block {
  return { id: 'b1', label: 'L', ...over } as Block
}

describe('validateBlock — required', () => {
  it('обязательное пустое → сообщение (все виды пустоты)', () => {
    expect(validateBlock(block({ type: 'short_text', required: true }), undefined)).toBe(
      'Обязательное поле',
    )
    expect(validateBlock(block({ type: 'short_text', required: true }), '')).toBe(
      'Обязательное поле',
    )
    expect(validateBlock(block({ type: 'multi_choice', required: true }), [])).toBe(
      'Обязательное поле',
    )
  })
  it('обязательное заполненное → null', () => {
    expect(validateBlock(block({ type: 'short_text', required: true }), 'текст')).toBeNull()
    expect(validateBlock(block({ type: 'single_choice', required: true }), 'opt1')).toBeNull()
    expect(validateBlock(block({ type: 'multi_choice', required: true }), ['o'])).toBeNull()
  })
  it('необязательное пустое → null (формат не проверяется)', () => {
    expect(validateBlock(block({ type: 'email' }), '')).toBeNull()
    expect(validateBlock(block({ type: 'number' }), undefined)).toBeNull()
  })
})

describe('validateBlock — формат', () => {
  it('email', () => {
    expect(validateBlock(block({ type: 'email' }), 'a@b.co')).toBeNull()
    expect(validateBlock(block({ type: 'email' }), 'нет-собаки')).toBe('Некорректный email')
  })
  it('number', () => {
    expect(validateBlock(block({ type: 'number' }), '42')).toBeNull()
    expect(validateBlock(block({ type: 'number' }), '-3.5')).toBeNull()
    expect(validateBlock(block({ type: 'number' }), 'abc')).toBe('Введите число')
  })
  it('date', () => {
    expect(validateBlock(block({ type: 'date' }), '2026-07-12')).toBeNull()
    expect(validateBlock(block({ type: 'date' }), '12.07.2026')).toBe('Некорректная дата')
    expect(validateBlock(block({ type: 'date' }), '2026-13-40')).toBe('Некорректная дата')
  })
})

describe('validateAll', () => {
  it('собирает только невалидные блоки', () => {
    const blocks = [
      block({ type: 'short_text', required: true }),
      block({ type: 'email' }),
      block({ type: 'number' }),
    ].map((b, i) => ({ ...b, id: `b${i}` }))
    const errors = validateAll(blocks, { b1: 'плохой-email', b2: '10' }) // b0 пустой обяз., b1 битый email
    expect(errors).toEqual({ b0: 'Обязательное поле', b1: 'Некорректный email' })
  })
  it('всё валидно → пустая карта', () => {
    const blocks = [block({ type: 'short_text', id: 'b0' }), block({ type: 'email', id: 'b1' })]
    expect(validateAll(blocks, { b1: 'a@b.co' })).toEqual({})
  })
})

// Обязательность из ПЛАНА (фаза 21): у блока может стоять requiredIf, и решает его
// сработавшее условие, а не флаг документа. Без аргумента поведение прежнее.
describe('обязательность приходит из плана', () => {
  const block: Block = { id: 'b', groupId: 'g', type: 'short_text' }

  it('без аргумента берётся флаг блока', () => {
    expect(validateBlock({ ...block, required: true }, undefined)).toBe('Обязательное поле')
    expect(validateBlock(block, undefined)).toBeNull()
  })

  it('план перебивает флаг в обе стороны', () => {
    expect(validateBlock(block, undefined, true)).toBe('Обязательное поле')
    expect(validateBlock({ ...block, required: true }, undefined, false)).toBeNull()
  })

  it('validateAll спрашивает обязательность у множества плана', () => {
    const blocks: Block[] = [block, { id: 'c', groupId: 'g2', type: 'short_text' }]
    const errors = validateAll(blocks, {}, new Set(['c']))
    expect(errors).toEqual({ c: 'Обязательное поле' })
  })
})
