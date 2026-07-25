import { describe, expect, it } from 'vitest'
import { groupBlocks, packRows } from '@fields/groups'
import type { Block } from '@entities/formSchema'

// packRows (@fields/groups) — раскладчик рядов half-вопросов (спека §5), общий
// для превью, рендерера и полотна. Тест живёт рядом с formSchema.test.ts: у
// web/shared своего vitest нет, прогоняет кабинет.

const field = (id: string, half = false): Block => ({
  id,
  groupId: id,
  type: 'short_text',
  ...(half ? { settings: { width: 'half' } } : {}),
})

const caption = (id: string, groupId: string): Block => ({ id, groupId, type: 'title', text: 'Q' })

const rows = (blocks: Block[]): string[][] =>
  packRows(groupBlocks(blocks)).map((row) => row.map((g) => g.id))

describe('packRows', () => {
  it('два соседних half — один ряд', () => {
    expect(rows([field('a', true), field('b', true)])).toEqual([['a', 'b']])
  })

  it('full-вопросы — каждый своим рядом', () => {
    expect(rows([field('a'), field('b')])).toEqual([['a'], ['b']])
  })

  it('одинокая половина — ряд из одного (рендер во всю ширину, дыры нет)', () => {
    expect(rows([field('a', true), field('b')])).toEqual([['a'], ['b']])
  })

  it('half через full не спаривается — пары только смежные', () => {
    expect(rows([field('a', true), field('b'), field('c', true)])).toEqual([['a'], ['b'], ['c']])
  })

  it('три half подряд: пара + одинокий хвост', () => {
    expect(rows([field('a', true), field('b', true), field('c', true)])).toEqual([
      ['a', 'b'],
      ['c'],
    ])
  })

  it('четыре half подряд — два ряда', () => {
    expect(rows([field('a', true), field('b', true), field('c', true), field('d', true)])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('half у мульти-группы «подпись+поле» виден по отвечаемому блоку', () => {
    const blocks = [
      caption('t1', 'a'),
      field('a', true),
      caption('t2', 'b'),
      field('b', true),
    ]
    expect(rows(blocks)).toEqual([['a', 'b']])
  })

  it('порядок документа не меняется — конкатенация рядов = исходный список групп', () => {
    const blocks = [field('a', true), field('b'), field('c', true), field('d', true), field('e')]
    const flat = packRows(groupBlocks(blocks)).flat().map((g) => g.id)
    expect(flat).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
