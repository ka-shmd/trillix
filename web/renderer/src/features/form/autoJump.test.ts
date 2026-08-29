import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'

import { shouldAutoJump } from './autoJump'

const block = (id: string, type: Block['type']): Block =>
  ({ id, groupId: id, type }) as unknown as Block

describe('автопереход после ответа', () => {
  it('листает страницу с одним вопросом выбором', () => {
    const one = block('a', 'single_choice')
    expect(shouldAutoJump([one], one, 'yes')).toBe(true)
  })

  it('не листает, когда на странице второй вопрос', () => {
    // Прыжок унёс бы человека от вопроса, которого он ещё не видел.
    const one = block('a', 'single_choice')
    const two = block('b', 'short_text')
    expect(shouldAutoJump([one, two], one, 'yes')).toBe(false)
  })

  it('не листает по набору текста', () => {
    // У текста нет момента «ответ дан»: форма улетала бы посреди слова.
    const text = block('a', 'short_text')
    expect(shouldAutoJump([text], text, 'Анна')).toBe(false)
  })

  it('не листает по снятому выбору', () => {
    const one = block('a', 'single_choice')
    expect(shouldAutoJump([one], one, '')).toBe(false)
    expect(shouldAutoJump([one], one, [])).toBe(false)
  })

  it('подпись рядом с вопросом переходу не мешает', () => {
    // Неотвечаемые блоки (текст, картинка, разрыв) на странице законны и в счёт не
    // идут: считаются вопросы, а не элементы.
    const one = block('a', 'dropdown')
    expect(shouldAutoJump([block('t', 'text'), one], one, 'x')).toBe(true)
  })
})
