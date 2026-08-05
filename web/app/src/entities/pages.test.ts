import { describe, expect, it } from 'vitest'
import { groupBlocks, packRows, pageNumbers, splitPages } from '@fields/groups'
import { type Block, type BlockType } from '@entities/formSchema'

// splitPages (@fields/groups) — разбиение документа на страницы разрывами (фаза 19),
// общее для рендерера, превью и полотна. Тест живёт рядом с groups.test.ts по той же
// причине: у web/shared своего vitest нет, прогоняет кабинет.

const block = (id: string, type: BlockType = 'short_text', right = false): Block => ({
  id,
  groupId: id,
  type,
  ...(right ? { settings: { column: 'right' } } : {}),
})

const brk = (id: string): Block => ({ id, groupId: id, type: 'page_break' })

// Страницы печатаем id блоков: ['a b', 'c'] — две страницы, на первой два блока.
const pages = (blocks: Block[]): string[] =>
  splitPages(blocks).map((page) => page.map((b) => b.id).join(' '))

describe('splitPages', () => {
  it('форма без разрывов — одна страница', () => {
    expect(pages([block('a'), block('b')])).toEqual(['a b'])
  })

  it('разрыв делит поток и сам в страницы не попадает', () => {
    expect(pages([block('a'), brk('p'), block('b')])).toEqual(['a', 'b'])
  })

  it('пустой документ — одна пустая страница, а не ноль страниц', () => {
    expect(splitPages([])).toEqual([[]])
  })

  // Три вырожденных случая: все они — законные промежуточные состояния набора и драга,
  // поэтому схема их принимает, а мусора на экране быть не должно.
  it('разрыв первым блоком не даёт пустой первой страницы', () => {
    expect(pages([brk('p'), block('a')])).toEqual(['a'])
  })

  it('два разрыва подряд не дают пустой страницы между ними', () => {
    expect(pages([block('a'), brk('p1'), brk('p2'), block('b')])).toEqual(['a', 'b'])
  })

  it('разрыв последним блоком не даёт пустой страницы в конце', () => {
    expect(pages([block('a'), brk('p')])).toEqual(['a'])
  })

  it('документ из одних разрывов — одна пустая страница', () => {
    expect(splitPages([brk('p1'), brk('p2')])).toEqual([[]])
  })

  it('порядок блоков внутри страниц — документный', () => {
    const flat = splitPages([block('a'), block('b'), brk('p'), block('c')])
      .flat()
      .map((b) => b.id)
    expect(flat).toEqual(['a', 'b', 'c'])
  })
})

// Разрыв — ГРАНИЦА раскладки, а не её элемент: секция через него не склеивается. Иначе
// два вопроса одного ряда разъехались бы по разным страницам, а канон стора пометил бы
// разрыв битом 'left' — документ, который отвергает схема (canShareRow), то есть 422 на
// автосейве формы, которую автор даже не правил.
describe('разрыв и ряды', () => {
  const rows = (blocks: Block[]): string[][] =>
    packRows(groupBlocks(blocks)).map((row) => row.map((cell) => cell.map((g) => g.id).join('+')))

  it('бит справа не забирает разрыв в ряд', () => {
    expect(rows([block('a'), brk('p'), block('b', 'short_text', true)])).toEqual([
      ['a'],
      ['p'],
      ['b'],
    ])
  })

  it('разрыв закрывает открытую секцию', () => {
    expect(
      rows([block('a'), block('b', 'short_text', true), brk('p'), block('c', 'short_text', true)]),
    ).toEqual([['a', 'b'], ['p'], ['c']])
  })
})

// pageNumbers — метка «Страница N» на разделителе полотна. Считается тем же разбиением,
// что режет форму респонденту: разойдись они, автор увидел бы на полотне страницу,
// которой у респондента нет. Отсутствие разрыва в карте = он инертен и подписывается без
// номера (но НЕ удаляется: за ним автор ещё допишет блоки).
describe('pageNumbers', () => {
  const numbers = (blocks: Block[]): (number | undefined)[] =>
    blocks.filter((b) => b.type === 'page_break').map((b) => pageNumbers(blocks).get(b.id))

  it('разрыв подписан номером страницы, которую открывает', () => {
    expect(numbers([block('a'), brk('p1'), block('b'), brk('p2'), block('c')])).toEqual([2, 3])
  })

  it('число меток равно числу страниц минус первая', () => {
    const blocks = [block('a'), brk('p1'), block('b'), brk('p2'), block('c')]
    expect(pageNumbers(blocks).size).toBe(splitPages(blocks).length - 1)
  })

  it('разрыв в конце инертен — страницы за ним нет', () => {
    expect(numbers([block('a'), brk('p')])).toEqual([undefined])
  })

  it('из двух подряд номер несёт второй — первый не делит ничего', () => {
    expect(numbers([block('a'), brk('p1'), brk('p2'), block('b')])).toEqual([undefined, 2])
  })

  it('разрыв выше всего содержимого инертен: страницы перед ним нет', () => {
    expect(numbers([brk('p'), block('a')])).toEqual([undefined])
  })

  it('нумерация не сбивается инертным разрывом посередине', () => {
    expect(
      numbers([block('a'), brk('p1'), block('b'), brk('p2'), brk('p3'), block('c')]),
    ).toEqual([2, undefined, 3])
  })
})
