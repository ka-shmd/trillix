import { describe, expect, it } from 'vitest'
import {
  blockRowWidths,
  cellVars,
  groupBlocks,
  groupRowWidths,
  optionRowWidths,
  packGroupRows,
  packOptionRows,
  packRows,
} from '@fields/groups'
import { type Block, type BlockType, type Option, textFromString } from '@entities/formSchema'

// packRows/packOptionRows (@fields/groups) — раскладчик рядов (спека §5/§5.1), общий
// для превью, рендерера и полотна. Тест живёт рядом с formSchema.test.ts: у
// web/shared своего vitest нет, прогоняет кабинет.

const field = (id: string, right = false, type: BlockType = 'short_text'): Block => ({
  id,
  groupId: id,
  type,
  ...(right ? { settings: { column: 2 } } : {}),
})

const caption = (id: string, groupId: string, right = false): Block => ({
  id,
  groupId,
  type: 'title',
  text: textFromString('Q'),
  ...(right ? { settings: { column: 2 } } : {}),
})

// Ряд печатаем колонками: ['a', 'b'] — по одному в каждой, ['a', 'b+c'] — стопка из
// двух в правой. Плоская запись читается в ожиданиях лучше вложенных массивов.
const rows = (blocks: Block[]): string[][] =>
  packRows(groupBlocks(blocks)).map((row) => row.map((cell) => cell.map((g) => g.id).join('+')))

const opt = (id: string, right = false): Option => ({ id, label: id, ...(right ? { column: 2 as const } : {}) })

const optRows = (options: Option[]): string[][] =>
  packOptionRows(options).map((row) => row.map((cell) => cell.map((o) => o.id).join('+')))

describe('packRows', () => {
  it('right встаёт в ряд с предыдущим', () => {
    expect(rows([field('a'), field('b', true)])).toEqual([['a', 'b']])
  })

  it('без флага — каждый своим рядом', () => {
    expect(rows([field('a'), field('b')])).toEqual([['a'], ['b']])
  })

  // Прежнее «ряд не берёт третьего» отменено (решение владельца 2026-07-29): правая
  // колонка это СТОПКА — при длинном блоке слева справа помещается несколько коротких.
  it('третий с битом уходит в стопку правой колонки, а не в новый ряд', () => {
    expect(rows([field('a'), field('b', true), field('c', true)])).toEqual([['a', 'b+c']])
    expect(rows([field('a'), field('b', true), field('c', true), field('d', true)])).toEqual([
      ['a', 'b+c+d'],
    ])
  })

  it('элемент без бита стопку закрывает и открывает свой ряд', () => {
    expect(rows([field('a'), field('b', true), field('c'), field('d', true)])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  // Левая колонка всегда об одном элементе: стопку слева выразить нечем — бит значит
  // «справа от предыдущего», и элемент без бита ряд закрывает.
  it('слева стопки не бывает', () => {
    const packed = packRows(groupBlocks([field('a'), field('b', true), field('c', true)]))
    expect(packed[0]![0]).toHaveLength(1)
    expect(packed[0]![1]).toHaveLength(2)
  })

  it('флаг у первого блока инертен — ряд из одного, дыры нет', () => {
    expect(rows([field('a', true), field('b')])).toEqual([['a'], ['b']])
  })

  // Whitelist коротких контролов отменён (решение владельца 2026-07-29, ADR §10): что
  // читается в половину колонки, решает автор формы, а не раскладчик.
  it('длинный ответ и выбор делят ряд наравне с коротким полем', () => {
    expect(rows([field('a', false, 'long_text'), field('b', true)])).toEqual([['a', 'b']])
    expect(rows([field('a'), field('b', true, 'single_choice')])).toEqual([['a', 'b']])
  })

  it('одинокий лэйаут-блок — полноправный участник ряда с обеих сторон', () => {
    const heading = (id: string, right = false): Block => ({
      id,
      groupId: id,
      type: 'heading',
      text: textFromString('Раздел'),
      ...(right ? { settings: { column: 2 } } : {}),
    })
    // Лэйаут справа от вопроса…
    expect(rows([field('a'), heading('h', true)])).toEqual([['a', 'h']])
    // …и слева от него: бит несёт тот, кто справа, — сторона задаётся порядком.
    expect(rows([heading('h'), field('a', true)])).toEqual([['h', 'a']])
  })

  // v4 (§6.3): носитель кросс-группового бита — ПЕРВЫЙ блок группы. У мульти-группы
  // это подпись; на отвечаемом блоке тот же ключ значит уже другое (тест ниже).
  it('флаг у мульти-группы «подпись+поле» читается с подписи', () => {
    const blocks = [caption('t1', 'a'), field('a'), caption('t2', 'b', true), field('b')]
    expect(rows(blocks)).toEqual([['a', 'b']])
  })

  it('флаг на отвечаемом блоке мульти-группы кросс-групповым рядом НЕ является', () => {
    const blocks = [caption('t1', 'a'), field('a'), caption('t2', 'b'), field('b', true)]
    expect(rows(blocks)).toEqual([['a'], ['b']])
  })

  // §6.5: группа с внутренним рядом занимает всю ширину и в кросс-групповой ряд не
  // встаёт — иначе в одной строке оказались бы четыре ячейки.
  it('группа с внутренним рядом не делит ряд с соседней', () => {
    const inner = [caption('t2', 'b'), field('b', true)] // «подпись | поле» внутри вопроса
    expect(rows([field('a'), ...inner.map((b) => ({ ...b }))])).toEqual([['a'], ['b']])
    // и наоборот: с внутренним рядом слева ряд тоже не собирается
    expect(rows([...inner, caption('t3', 'c', true), field('c')])).toEqual([['b'], ['c']])
  })

  it('порядок документа не меняется — конкатенация рядов = исходный список групп', () => {
    const blocks = [field('a'), field('b', true), field('c'), field('d', true), field('e', true)]
    const flat = packRows(groupBlocks(blocks))
      .flat(2)
      .map((g) => g.id)
    expect(flat).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

// Первый проход раскладчика (§6.4): блоки ОДНОЙ группы в ряды. Правило v1 узкое
// (§6.5) — в ряд встаёт только пара «подпись + поле».
// ДВУХКОЛОНОЧНАЯ СЕКЦИЯ (спека §11, решение владельца 2026-07-29): у ключа три
// состояния, в каждой колонке сколько угодно элементов, а элемент без ключа секцию
// ЗАКРЫВАЕТ. Печатаем колонками, стопку внутри колонки — через «+».
describe('packRows — секция', () => {
  const left = (id: string): Block => ({ id, groupId: id, type: 'short_text', settings: { column: 1 } })
  const right = (id: string): Block => ({ id, groupId: id, type: 'short_text', settings: { column: 2 } })

  it('в каждой колонке сколько угодно элементов', () => {
    expect(rows([left('a'), left('b'), left('c'), right('d'), right('e')])).toEqual([['a+b+c', 'd+e']])
  })

  it('элемент без ключа закрывает секцию и встаёт во всю ширину', () => {
    expect(rows([left('a'), right('b'), field('c'), left('d'), right('e')])).toEqual([
      ['a', 'b'],
      ['c'],
      ['d', 'e'],
    ])
  })

  // Иначе форма, собранная до этапа, молча превращала бы два ряда в одну секцию 2+2 —
  // с другим вертикальным выравниванием.
  it("'left' после 'right' открывает НОВУЮ секцию, а не продолжает прежнюю", () => {
    expect(rows([left('a'), right('b'), left('c'), right('d')])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('секции с пустой колонкой не бывает: одинокий left — полная ширина', () => {
    expect(rows([left('a'), field('b')])).toEqual([['a'], ['b']])
  })

  it('неявная левая колонка: right забирает предыдущий полноширинный элемент', () => {
    expect(rows([field('a'), right('b')])).toEqual([['a', 'b']])
    // Забирать некого — бит инертен, дыры нет.
    expect(rows([right('a'), field('b')])).toEqual([['a'], ['b']])
  })

  it('порядок документа неприкосновенен — конкатенация колонок = исходный список', () => {
    const blocks = [left('a'), left('b'), right('c'), field('d'), field('e'), right('f')]
    expect(
      packRows(groupBlocks(blocks))
        .flat(2)
        .map((g) => g.id),
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})

describe('packGroupRows', () => {
  const inner = (blocks: Block[]): string[][] =>
    packGroupRows(blocks).map((row) => row.map((cell) => cell.map((b) => b.id).join('+')))

  it('подпись и короткое поле встают в один ряд', () => {
    expect(inner([caption('t', 'g'), field('f', true)])).toEqual([['t', 'f']])
  })

  it('без флага у поля — каждый своей строкой', () => {
    expect(inner([caption('t', 'g'), field('f')])).toEqual([['t'], ['f']])
  })

  it('контент между подписью и полем ряд разрывает: парой он не бывает', () => {
    const text: Block = { id: 'd', groupId: 'g', type: 'text', text: textFromString('пояснение') }
    expect(inner([caption('t', 'g'), text, field('f', true)])).toEqual([['t'], ['d'], ['f']])
  })

  it('whitelist не проверяется и здесь: длинный ответ встаёт рядом с подписью', () => {
    expect(inner([caption('t', 'g'), field('f', true, 'long_text')])).toEqual([['t', 'f']])
  })

  it('пара направленная: поле слева, подпись справа рядом не встают', () => {
    expect(inner([field('f'), caption('t', 'g', true)])).toEqual([['f'], ['t']])
  })

  it('бит первого блока (кросс-групповой носитель) внутренний ряд не собирает', () => {
    expect(inner([caption('t', 'g', true), field('f')])).toEqual([['t'], ['f']])
  })
})

describe('packOptionRows', () => {
  it('тот же бит и та же упаковка, что у вопросов', () => {
    expect(optRows([opt('o1'), opt('o2', true), opt('o3'), opt('o4', true)])).toEqual([
      ['o1', 'o2'],
      ['o3', 'o4'],
    ])
  })

  // Ядро общее, поэтому стопка есть и у вариантов (жест её пока не предлагает — см.
  // optionRowHasFreeCell в сторе).
  it('третий с битом уходит в стопку правой колонки', () => {
    expect(optRows([opt('o1'), opt('o2', true), opt('o3', true)])).toEqual([['o1', 'o2+o3']])
  })

  it('флаг у первого варианта инертен', () => {
    expect(optRows([opt('o1', true), opt('o2')])).toEqual([['o1'], ['o2']])
  })

  it('whitelist к вариантам не применяется — карточка делит ряд всегда', () => {
    expect(optRows([opt('o1'), opt('o2', true)])).toEqual([['o1', 'o2']])
  })

  it('порядок документа не меняется', () => {
    const flat = packOptionRows([opt('o1'), opt('o2', true), opt('o3')])
      .flat(2)
      .map((o) => o.id)
    expect(flat).toEqual(['o1', 'o2', 'o3'])
  })
})

// ШИРИНЫ КОЛОНОК (2026-08-22). Правило действия одно на все три слоя и живёт в
// раскладчике: доля у первого элемента КАЖДОЙ колонки и сумма ровно 100. Проверяется
// здесь, потому что из него выводится обещанный владельцу сброс в равные — ни одна
// команда ряда для этого своей проверки не имеет.
describe('rowWidths — доли колонок', () => {
  const wide = (id: string, column: number, columnWidth: number): Block => ({
    id,
    groupId: id,
    type: 'short_text',
    settings: { column, columnWidth },
  })
  const widthsOf = (blocks: Block[]): (number[] | null)[] =>
    packRows(groupBlocks(blocks)).map((row) => groupRowWidths(row))

  it('доли у всех колонок и сумма 100 — действуют', () => {
    expect(widthsOf([wide('a', 1, 70), wide('b', 2, 30)])).toEqual([[70, 30]])
  })

  it('колонку добавили (у новой доли нет) — ряд поровну', () => {
    const third: Block = { id: 'c', groupId: 'c', type: 'short_text', settings: { column: 3 } }
    expect(widthsOf([wide('a', 1, 70), wide('b', 2, 30), third])).toEqual([null])
  })

  it('колонку унесли (сумма не сходится) — ряд поровну', () => {
    expect(widthsOf([wide('a', 1, 50), wide('b', 2, 20)])).toEqual([null])
  })

  it('ряд из одной колонки долей не имеет', () => {
    expect(widthsOf([wide('a', 1, 100)])).toEqual([null])
  })

  it('доля читается у ПЕРВОГО элемента колонки, стопка её не меняет', () => {
    const blocks = [wide('a', 1, 70), wide('b', 2, 30), wide('c', 2, 55)]
    expect(widthsOf(blocks)).toEqual([[70, 30]])
  })

  it('внутренний ряд вопроса — тот же расчёт', () => {
    const inner = packGroupRows([
      { id: 't', groupId: 'g', type: 'title', text: textFromString('Q'), settings: { column: 1, columnWidth: 35 } },
      { id: 'f', groupId: 'g', type: 'short_text', settings: { column: 2, columnWidth: 65 } },
    ])
    expect(inner.map((row) => blockRowWidths(row))).toEqual([[35, 65]])
  })

  it('ряд вариантов — тот же расчёт', () => {
    const options: Option[] = [
      { id: 'o1', label: 'Да', column: 1, columnWidth: 25 },
      { id: 'o2', label: 'Нет', column: 2, columnWidth: 75 },
    ]
    expect(packOptionRows(options).map((row) => optionRowWidths(row))).toEqual([[25, 75]])
  })

  it('cellVars печатает переменную только у действующих долей', () => {
    expect(cellVars([70, 30], 1)).toEqual({ '--rf-cell-grow': 30 })
    expect(cellVars(null, 0)).toBeUndefined()
  })
})
