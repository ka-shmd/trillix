import { describe, expect, it } from 'vitest'
import { textFromString, type Block } from '@entities/formSchema'

import { answerColumns } from './columns'

const block = (over: Partial<Block>): Block =>
  ({
    id: 'blk_1',
    groupId: 'g1',
    type: 'short_text',
    ...over,
  }) as Block

describe('answerColumns', () => {
  it('колонку получает только отвечаемый блок', () => {
    // Подписи и контент ответов не собирают — колонка под них была бы всегда пустой
    // (то же правило, по которому они исключены из CSV).
    const blocks = [
      block({ id: 'blk_t', groupId: 'g1', type: 'label', text: textFromString('Ваша почта') }),
      block({ id: 'blk_e', groupId: 'g1', type: 'email' }),
    ]
    expect(answerColumns(blocks).map((c) => c.block.id)).toEqual(['blk_e'])
  })

  it('подпись берёт из имени вопроса раньше заголовка группы', () => {
    // Имя вопроса — то же, чем названа колонка выгрузки (domain.questionLabel).
    // Разойдись они, таблица и CSV называли бы один вопрос по-разному.
    const blocks = [
      block({ id: 'blk_t', groupId: 'g1', type: 'label', text: textFromString('Ваша почта') }),
      block({ id: 'blk_e', groupId: 'g1', type: 'email', name: 'Почта' }),
    ]
    expect(answerColumns(blocks)[0]!.label).toBe('Почта')
  })

  it('без имени берёт заголовок группы', () => {
    const blocks = [
      block({ id: 'blk_t', groupId: 'g1', type: 'label', text: textFromString('Ваша почта') }),
      block({ id: 'blk_e', groupId: 'g1', type: 'email' }),
    ]
    expect(answerColumns(blocks)[0]!.label).toBe('Ваша почта')
  })

  it('без имени и заголовка берёт подсказку поля', () => {
    const blocks = [block({ id: 'blk_e', type: 'email', settings: { placeholder: 'you@mail.ru' } })]
    expect(answerColumns(blocks)[0]!.label).toBe('you@mail.ru')
  })

  it('безымянный вопрос называет честно, а не пустой строкой', () => {
    // Пустая шапка колонки читается как поломка вёрстки, а не как «вопрос не назван».
    expect(answerColumns([block({ id: 'blk_e', type: 'email' })])[0]!.label).toBe('(без названия)')
  })
})
