import { describe, expect, it } from 'vitest'
import { groupBlocks, packOptionRows, packRows } from '@fields/groups'
import { type Block, type BlockType, type Option, textFromString } from '@entities/formSchema'

// packRows/packOptionRows (@fields/groups) — раскладчик рядов (спека §5/§5.1), общий
// для превью, рендерера и полотна. Тест живёт рядом с formSchema.test.ts: у
// web/shared своего vitest нет, прогоняет кабинет.

const field = (id: string, right = false, type: BlockType = 'short_text'): Block => ({
  id,
  groupId: id,
  type,
  ...(right ? { settings: { column: 'right' } } : {}),
})

const caption = (id: string, groupId: string): Block => ({ id, groupId, type: 'title', text: textFromString('Q') })

const rows = (blocks: Block[]): string[][] =>
  packRows(groupBlocks(blocks)).map((row) => row.map((g) => g.id))

const opt = (id: string, right = false): Option => ({ id, label: id, ...(right ? { column: 'right' as const } : {}) })

const optRows = (options: Option[]): string[][] =>
  packOptionRows(options).map((row) => row.map((o) => o.id))

describe('packRows', () => {
  it('right встаёт в ряд с предыдущим', () => {
    expect(rows([field('a'), field('b', true)])).toEqual([['a', 'b']])
  })

  it('без флага — каждый своим рядом', () => {
    expect(rows([field('a'), field('b')])).toEqual([['a'], ['b']])
  })

  it('ряд не берёт третьего: пара + новый ряд', () => {
    expect(rows([field('a'), field('b', true), field('c', true)])).toEqual([['a', 'b'], ['c']])
  })

  it('четыре подряд с флагом у второго и четвёртого — два ряда', () => {
    expect(rows([field('a'), field('b', true), field('c'), field('d', true)])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('флаг у первого блока инертен — ряд из одного, дыры нет', () => {
    expect(rows([field('a', true), field('b')])).toEqual([['a'], ['b']])
  })

  it('флаг инертен, если левый сосед не умеет делить ряд', () => {
    expect(rows([field('a', false, 'long_text'), field('b', true)])).toEqual([['a'], ['b']])
  })

  it('флаг инертен у типа вне whitelist (схема из прошлого/чужая)', () => {
    expect(rows([field('a'), field('b', true, 'long_text')])).toEqual([['a'], ['b']])
  })

  it('группа без отвечаемого блока партнёром не становится', () => {
    const blocks = [
      { id: 'h', groupId: 'h', type: 'heading' as BlockType, text: textFromString('Раздел') },
      field('b', true),
    ]
    expect(rows(blocks)).toEqual([['h'], ['b']])
  })

  it('флаг у мульти-группы «подпись+поле» виден по отвечаемому блоку', () => {
    const blocks = [caption('t1', 'a'), field('a'), caption('t2', 'b'), field('b', true)]
    expect(rows(blocks)).toEqual([['a', 'b']])
  })

  it('порядок документа не меняется — конкатенация рядов = исходный список групп', () => {
    const blocks = [field('a'), field('b', true), field('c'), field('d', true), field('e', true)]
    const flat = packRows(groupBlocks(blocks))
      .flat()
      .map((g) => g.id)
    expect(flat).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('packOptionRows', () => {
  it('тот же бит и та же упаковка, что у вопросов', () => {
    expect(optRows([opt('o1'), opt('o2', true), opt('o3'), opt('o4', true)])).toEqual([
      ['o1', 'o2'],
      ['o3', 'o4'],
    ])
  })

  it('ряд не берёт третьего', () => {
    expect(optRows([opt('o1'), opt('o2', true), opt('o3', true)])).toEqual([['o1', 'o2'], ['o3']])
  })

  it('флаг у первого варианта инертен', () => {
    expect(optRows([opt('o1', true), opt('o2')])).toEqual([['o1'], ['o2']])
  })

  it('whitelist к вариантам не применяется — карточка делит ряд всегда', () => {
    expect(optRows([opt('o1'), opt('o2', true)])).toEqual([['o1', 'o2']])
  })

  it('порядок документа не меняется', () => {
    const flat = packOptionRows([opt('o1'), opt('o2', true), opt('o3')])
      .flat()
      .map((o) => o.id)
    expect(flat).toEqual(['o1', 'o2', 'o3'])
  })
})
