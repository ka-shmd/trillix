import { describe, expect, it } from 'vitest'
import {
  groupBlocks,
  packRows,
  pageName,
  pageNumbers,
  splitPages,
  splitThankYou,
  thankYouIssue,
} from '@fields/groups'
import { type Block, type BlockType } from '@entities/formSchema'

// splitPages (@fields/groups) — разбиение документа на страницы разрывами (фаза 19),
// общее для рендерера, превью и полотна. Тест живёт рядом с groups.test.ts по той же
// причине: у web/shared своего vitest нет, прогоняет кабинет.

const block = (id: string, type: BlockType = 'short_text', right = false): Block => ({
  id,
  groupId: id,
  type,
  ...(right ? { settings: { column: 2 } } : {}),
})

const brk = (id: string): Block => ({ id, groupId: id, type: 'page_break' })

const heading = (id: string): Block => ({ id, groupId: id, type: 'heading', text: [{ t: id }] })

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

// ЭКРАН ПОСЛЕ ОТПРАВКИ — та же страница документа, помеченная флагом на разрыве
// (2026-08-21). Флаг легален всегда, а вот ДЕЙСТВУЕТ он по трём производным условиям:
// страница последняя, страниц больше одной, отвечаемых блоков на ней нет. Условия живут
// в раскладчике, а не в схеме, — иначе автор ловил бы 422 в момент, когда ставит вопрос
// на эту страницу или тянет мимо неё блок.
describe('splitThankYou', () => {
  const tyBrk = (id: string): Block => ({
    id,
    groupId: id,
    type: 'page_break',
    settings: { thankYou: true },
  })
  // Печатаем «что осталось формой | что уехало экраном»; '-' — экрана нет.
  const split = (blocks: Block[]): string => {
    const out = splitThankYou(blocks)
    return `${out.blocks.map((b) => b.id).join(' ')} | ${out.thankYou?.map((b) => b.id).join(' ') ?? '-'}`
  }

  it('последняя страница с флагом уезжает экраном вместе со своим разрывом', () => {
    expect(split([block('a'), tyBrk('p'), heading('h')])).toBe('a | h')
  })

  it('без флага документ не режется', () => {
    expect(split([block('a'), brk('p'), heading('h')])).toBe('a p h | -')
  })

  it('флаг на разрыве НЕ последней страницы игнорируется', () => {
    expect(split([block('a'), tyBrk('p1'), heading('h'), brk('p2'), block('b')])).toBe(
      'a p1 h p2 b | -',
    )
  })

  // Тот же случай, но страница ниже — без вопросов: тогда флаг гасит ровно правило «экран
  // последний», а не правило «нет отвечаемых». Без этого случая подмена «последняя
  // страница → первая» осталась бы незамеченной.
  it('флаг не на последней странице игнорируется, даже когда ниже одна вёрстка', () => {
    expect(split([block('a'), tyBrk('p1'), heading('h1'), brk('p2'), heading('h2')])).toBe(
      'a p1 h1 p2 h2 | -',
    )
  })

  it('отвечаемый блок на странице гасит флаг: это обычная страница', () => {
    expect(split([block('a'), tyBrk('p'), block('b')])).toBe('a p b | -')
  })

  // Экран после отправки — ХВОСТ документа, и форма перед ним может быть пустой: это не
  // «форма из одной благодарности», а начало сборки. Отправлять с пустой формы нечего,
  // но это забота планировщика кнопок (pageNavPlan), а не разреза.
  it('за разрывом только экран: форма пуста, экран есть', () => {
    expect(split([tyBrk('p'), heading('h')])).toBe(' | h')
  })

  // ПУСТОЙ хвост экраном не считается: показывать нечего, и рендерер берёт свою заглушку.
  // Флаг при этом законен — автор через секунду напишет текст (см. thankYouIssue).
  it('за разрывом пусто — экрана нет, но документ не тронут', () => {
    expect(split([block('a'), tyBrk('p')])).toBe('a p | -')
  })

  // Хвостовые разрывы внутри экрана инертны по построению и уезжают вместе с ним: границ
  // внутри экрана после отправки не бывает.
  it('инертный разрыв внутри экрана в форму не возвращается', () => {
    expect(split([block('a'), tyBrk('p1'), heading('h'), brk('p2')])).toBe('a | h')
  })

  it('экраном уезжает вся страница, а не первый её блок', () => {
    expect(split([block('a'), tyBrk('p'), heading('h1'), heading('h2')])).toBe('a | h1 h2')
  })
})

// Тумблер «Спасибо» стоит на КАЖДОМ разрыве и включается всегда, поэтому «включил, а
// ничего не изменилось» обязано быть объяснено на месте: thankYouIssue называет причину.
describe('thankYouIssue', () => {
  const issue = (blocks: Block[], id: string) => thankYouIssue(blocks, id)

  it('хвост без вопросов — ничто не мешает', () => {
    expect(issue([block('a'), brk('p'), heading('h')], 'p')).toBeNull()
  })

  it('ниже есть ещё страница', () => {
    const blocks = [block('a'), brk('p1'), heading('h'), brk('p2'), block('b')]
    expect(issue(blocks, 'p1')).toBe('not-last')
  })

  it('за разрывом стоит вопрос', () => {
    expect(issue([block('a'), brk('p'), block('b')], 'p')).toBe('question')
  })

  // Пустой хвост — законное состояние набора: запрет на него означал бы, что экран нельзя
  // вставить вовсе (свежий разрыв всегда пуст).
  it('за разрывом пусто — помехи нет', () => {
    expect(issue([block('a'), brk('p')], 'p')).toBeNull()
  })

  // Вопрос ниже подходит под оба условия, и назвать его надо тем, что поймёт автор.
  it('вопрос на чужой странице ниже зовётся «ниже есть ещё страница»', () => {
    expect(issue([block('a'), brk('p'), heading('h'), brk('p2'), block('b')], 'p')).toBe('not-last')
  })

  // Два разрыва подряд: у обоих один и тот же хвост, поэтому и ответ у них один — никакой
  // «последней страницы», в которой они расходятся, тут не спрашивается.
  it('два разрыва подряд отвечают одинаково', () => {
    const doc = [block('a'), brk('p1'), brk('p2'), block('b')]
    expect(issue(doc, 'p1')).toBe('question')
    expect(issue(doc, 'p2')).toBe('question')
  })
})

// pageName — одна точка подстановки дефолта: разойдись она, подпись разделителя на
// полотне разошлась бы с тем, как страница называется в аналитике.
describe('pageName', () => {
  it('своё имя автора', () => {
    expect(pageName({ settings: { pageName: 'Контакты' } }, 2)).toBe('Контакты')
  })

  it('пустое имя и пробелы — то же, что имени нет', () => {
    expect(pageName({ settings: { pageName: '   ' } }, 3)).toBe('Страница 3')
  })

  it('первая страница ничьим разрывом не открыта — только номер', () => {
    expect(pageName(null, 1)).toBe('Страница 1')
  })
})
