import { describe, expect, it } from 'vitest'

import { textFromString, type Block } from '@entities/formSchema'
import { publishBlockers, type PublishBlockerKind } from './publishGate'

// Зеркало internal/domain/publish_test.go — набор кейсов ТОТ ЖЕ, и правится он одним
// PR с Go-стороной. Разъехавшиеся стороны здесь означают не 422, а кое-что хуже:
// кабинет разрешает публикацию, которую сервер отвергает (или наоборот — прячет
// кнопку у формы, которую сервер принял бы).

const blk = (b: Partial<Block> & Pick<Block, 'id' | 'type'>): Block => ({
  groupId: 'g_' + b.id,
  ...b,
})

const kinds = (blocks: Block[]): PublishBlockerKind[] => publishBlockers(blocks).map((b) => b.kind)

describe('publishBlockers — пропускает', () => {
  const cases: Record<string, Block[]> = {
    'пустая форма': [],
    'только текст': [blk({ id: 'p', type: 'text', text: textFromString('Привет') })],
    'вопрос с заголовком': [
      blk({ id: 't', groupId: 'g1', type: 'title', text: textFromString('Ваше имя') }),
      blk({ id: 'b', groupId: 'g1', type: 'short_text' }),
    ],
    'голое поле с плейсхолдером': [
      blk({ id: 'b', type: 'email', settings: { placeholder: 'you@example.com' } }),
    ],
    'голое поле с именем': [blk({ id: 'b', type: 'scale', name: 'nps' })],
    'согласие со своим текстом': [
      blk({ id: 'c', type: 'consent', text: textFromString('Соглашаюсь') }),
    ],
    'choice с одним вариантом': [
      blk({ id: 't', groupId: 'g1', type: 'title', text: textFromString('Откуда узнали?') }),
      blk({
        id: 'b',
        groupId: 'g1',
        type: 'single_choice',
        settings: { options: [{ id: 'o1', label: 'Друзья' }] },
      }),
    ],
    // Заголовок ФОРМЫ — не подпись вопроса: пустой он законен (форма без названия
    // существует с фазы 15) и публикацию не держит.
    'пустой заголовок формы': [
      blk({ id: 'ft', groupId: 'gft', type: 'form_title' }),
      blk({ id: 'b', type: 'short_text', name: 'q' }),
    ],
  }

  for (const [name, blocks] of Object.entries(cases)) {
    it(name, () => {
      expect(kinds(blocks)).toEqual([])
    })
  }
})

describe('publishBlockers — блокирует', () => {
  const cases: Record<string, { blocks: Block[]; want: PublishBlockerKind[] }> = {
    'вопрос без имени вовсе': {
      blocks: [blk({ id: 'b', type: 'scale' })],
      want: ['unnamed_question'],
    },
    'заголовок из одних пробелов не считается': {
      blocks: [
        blk({ id: 't', groupId: 'g1', type: 'title', text: textFromString('   ') }),
        blk({ id: 'b', groupId: 'g1', type: 'short_text' }),
      ],
      want: ['empty_caption', 'unnamed_question'],
    },
    'пустая подпись при названном поле': {
      blocks: [
        blk({ id: 't', groupId: 'g1', type: 'title' }),
        blk({ id: 'b', groupId: 'g1', type: 'short_text', name: 'fio' }),
      ],
      want: ['empty_caption'],
    },
    'choice без вариантов': {
      blocks: [
        blk({ id: 't', groupId: 'g1', type: 'title', text: textFromString('Город') }),
        blk({ id: 'b', groupId: 'g1', type: 'dropdown' }),
      ],
      want: ['choice_without_options'],
    },
    // Один блок нарушает два правила — обязан дать два замечания: «почините одно,
    // узнаете про второе» это ровно то, чего список и избегает.
    'голый список выбора без заголовка': {
      blocks: [blk({ id: 'b', type: 'multi_choice' })],
      want: ['unnamed_question', 'choice_without_options'],
    },
    'порядок блокеров — порядок документа': {
      blocks: [
        blk({ id: 'b1', type: 'scale' }),
        blk({ id: 'l', groupId: 'g2', type: 'label' }),
        blk({ id: 'b2', groupId: 'g2', type: 'single_choice', name: 'q' }),
      ],
      want: ['unnamed_question', 'empty_caption', 'choice_without_options'],
    },
  }

  for (const [name, c] of Object.entries(cases)) {
    it(name, () => {
      expect(kinds(c.blocks)).toEqual(c.want)
    })
  }

  it('у каждого блокера есть адрес блока и текст', () => {
    for (const b of publishBlockers([blk({ id: 'b', type: 'multi_choice' })])) {
      expect(b.blockId).toBe('b')
      expect(b.message.length).toBeGreaterThan(0)
    }
  })
})
