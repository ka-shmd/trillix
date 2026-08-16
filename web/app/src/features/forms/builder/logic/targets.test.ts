import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'

import { JUMP_END, filterTargetTree, jumpTargetsFrom, logicBlockWarnings, targetTree } from './model'

// Плоский список id дерева целей — удобнее сравнивать, чем вложенную структуру.
const ids = (tree: ReturnType<typeof targetTree>): string[] =>
  tree.flatMap((p) => p.items.flatMap((n) => [n.id, ...n.children.map((c) => c.id)]))

// Редакторская сторона: что автору предлагают выбрать и о чём предупреждают. Цели с
// 2026-08-16 НЕ сужаются позицией (ADR §10) — блок волен стоять где угодно, а негодную
// пару «источник ниже цели» называет предупреждение. Семантику (что правило значит)
// знает вычислитель и проверяет entities/logic.test.ts.

const blk = (id: string, groupId: string, type: Block['type']): Block => ({ id, groupId, type })

const logic = (id: string, l: Block['logic']): Block => ({
  id,
  groupId: `g-${id}`,
  type: 'logic',
  logic: l,
})

// [q1cap q1] [L] [q2cap q2] [list]
const doc = (l: Block['logic'] = {}): Block[] => [
  blk('q1cap', 'g1', 'title'),
  blk('q1', 'g1', 'short_text'),
  logic('L', l),
  blk('q2cap', 'g2', 'title'),
  blk('q2', 'g2', 'phone'),
  {
    ...blk('list', 'g3', 'multi_choice'),
    settings: { options: [{ id: 'o1', label: 'Один' }, { id: 'o2', label: 'Два' }] },
  },
]

describe('дерево целей: страница → вопрос → варианты', () => {
  it('«показать» адресует вопросы, их СТРОКИ и варианты', () => {
    expect(ids(targetTree(doc(), 'show'))).toEqual([
      'q1cap',
      'q1',
      'q2cap',
      'q2',
      'list',
      'o1',
      'o2',
    ])
  })

  it('«обязателен» адресует отвечаемые, но НЕ варианты', () => {
    expect(ids(targetTree(doc(), 'require'))).toEqual(['q1', 'q2', 'list'])
  })

  it('строки и варианты висят на своём вопросе, а не отдельными узлами', () => {
    const tree = targetTree(doc(), 'show')
    const items = tree.flatMap((p) => p.items)
    // Голова в детях не повторяется: она и есть сам узел.
    expect(items.find((n) => n.id === 'q1cap')!.children.map((c) => c.id)).toEqual(['q1'])
    expect(items.find((n) => n.id === 'list')!.children.map((c) => c.id)).toEqual(['o1', 'o2'])
  })

  it('строка без своего текста называется именем ТИПА, а не именем вопроса', () => {
    const tree = targetTree(doc(), 'show')
    const row = tree.flatMap((p) => p.items).find((n) => n.id === 'q1cap')!.children[0]!
    expect(row.label).toBe('Короткий ответ')
  })

  // Глиф — свойство ТИПА, а тип есть только у блока (решение владельца 2026-08-16).
  // Поэтому в дереве он достаётся не всем пунктам, и «кому именно» проверяется здесь.
  describe('глиф достаётся только блоку', () => {
    const glyphs = (
      tree: ReturnType<typeof targetTree>,
    ): Record<string, string | undefined> =>
      Object.fromEntries(
        tree.flatMap((p) =>
          p.items.flatMap((n) => [
            [n.id, n.glyphType] as const,
            ...n.children.map((c) => [c.id, c.glyphType] as const),
          ]),
        ),
      )

    it('у ГРУППЫ глифа нет — вопрос из нескольких блоков сам блоком не является', () => {
      const g = glyphs(targetTree(doc(), 'show'))
      expect(g.q1cap).toBeUndefined()
      expect(g.q2cap).toBeUndefined()
    })

    it('строка вопроса несёт СВОЙ тип', () => {
      expect(glyphs(targetTree(doc(), 'show')).q1).toBe('short_text')
    })

    it('у ВАРИАНТА глифа нет — он не блок', () => {
      const g = glyphs(targetTree(doc(), 'show'))
      expect(g.o1).toBeUndefined()
      expect(g.o2).toBeUndefined()
    })

    it('одинокий блок — сам себе узел, и глиф у него собственный', () => {
      // Голое поле со списком: блоков в группе один, значит узел это он сам.
      expect(glyphs(targetTree(doc(), 'show')).list).toBe('multi_choice')
      expect(glyphs(targetTree([blk('h', 'gh', 'heading')], 'show')).h).toBe('heading')
    })

    it('«обязателен» адресует сам отвечаемый блок — его тип и берётся', () => {
      expect(glyphs(targetTree(doc(), 'require')).q1).toBe('short_text')
    })
  })

  it('сам блок logic целью не бывает', () => {
    const two = [...doc(), logic('L2', {})]
    expect(ids(targetTree(two, 'show'))).not.toContain('L2')
  })

  it('разрыв страницы и заголовок формы целью показа не бывают', () => {
    const paged: Block[] = [
      { id: 'ft', groupId: 'gft', type: 'form_title' },
      blk('q1cap', 'g1', 'title'),
      blk('br', 'gb', 'page_break'),
      blk('q2cap', 'g2', 'title'),
    ]
    expect(ids(targetTree(paged, 'show'))).toEqual(['q1cap', 'q2cap'])
  })

  it('цели раскладываются по страницам — так их показывает пикер', () => {
    const paged: Block[] = [
      blk('q1cap', 'g1', 'title'),
      blk('br', 'gb', 'page_break'),
      blk('q2cap', 'g2', 'title'),
    ]
    expect(targetTree(paged, 'show').map((p) => [p.page, p.items.map((n) => n.id)])).toEqual([
      [1, ['q1cap']],
      [2, ['q2cap']],
    ])
  })
})

describe('поиск по дереву целей', () => {
  const tree = targetTree(doc(), 'show')

  it('пустой запрос отдаёт дерево как есть', () => {
    expect(filterTargetTree(tree, '  ')).toBe(tree)
  })

  it('совпал вопрос — он остаётся со всеми своими детьми', () => {
    // Имя вопроса без подписи выводится (derivedQuestionName), поэтому берём его из
    // самого дерева, а не пишем строкой: иначе тест сломается от правки имён.
    const label = tree.flatMap((p) => p.items).find((n) => n.id === 'list')!.label
    const found = filterTargetTree(tree, label)
    expect(ids(found)).toEqual(['list', 'o1', 'o2'])
  })

  it('совпал только ВАРИАНТ — вопрос остаётся, чтобы было понятно, чей он', () => {
    const found = filterTargetTree(tree, 'Один')
    expect(ids(found)).toEqual(['list', 'o1'])
  })

  it('страница без совпадений уходит целиком', () => {
    expect(filterTargetTree(tree, 'ничего такого')).toEqual([])
  })
})

describe('цели перехода — страницы ниже блока', () => {
  // [q1] [L] | br1 | [q2] | br2 | [q3]
  const paged: Block[] = [
    blk('q1', 'g1', 'short_text'),
    logic('L', {}),
    blk('br1', 'gb1', 'page_break'),
    blk('q2', 'g2', 'short_text'),
    blk('br2', 'gb2', 'page_break'),
    blk('q3', 'g3', 'short_text'),
  ]

  it('предлагаются страницы вперёд и «к отправке»', () => {
    expect(jumpTargetsFrom(paged, 'L')).toEqual([
      { value: 'br1', label: 'Страница 2' },
      { value: 'br2', label: 'Страница 3' },
      { value: JUMP_END, label: 'К отправке' },
    ])
  })

  it('с последней страницы вести некуда, кроме отправки', () => {
    const late = [...paged, logic('L2', {})]
    expect(jumpTargetsFrom(late, 'L2')).toEqual([{ value: JUMP_END, label: 'К отправке' }])
  })
})

describe('предупреждения блока', () => {
  const warn = (l: Block['logic'], blocks = doc(l)): string[] => {
    const block = blocks.find((b) => b.id === 'L')!
    return logicBlockWarnings(blocks, block)
  }

  it('правильное правило предупреждений не даёт', () => {
    expect(
      warn({ when: { blockId: 'q1', op: 'answered' }, then: [{ kind: 'show', targets: ['q2cap'] }] }),
    ).toEqual([])
  })

  it('без действий условие меряется от самого блока', () => {
    const out = warn({ when: { blockId: 'list', op: 'answered' }, then: [] })
    expect(out.join(' ')).toContain('ниже')
  })

  it('источник ниже ЦЕЛИ — правило по этой цели не действует', () => {
    // Источник q2 стоит ниже цели q1cap: к моменту, когда решается цель, он не решён.
    const out = warn({ when: { blockId: 'q2', op: 'answered' }, then: [{ kind: 'show', targets: ['q1cap'] }] })
    expect(out.join(' ')).toContain('ниже')
  })

  it('цель ВЫШЕ блока предупреждения не даёт — позиция блока не важна', () => {
    // Блок стоит ПОСЛЕДНИМ и прячет вопрос в середине; источник при этом выше цели.
    const l: Block['logic'] = {
      when: { blockId: 'q1', op: 'answered' },
      then: [{ kind: 'show', targets: ['q2cap'] }],
    }
    const blocks: Block[] = [
      blk('q1cap', 'g1', 'title'),
      blk('q1', 'g1', 'short_text'),
      blk('q2cap', 'g2', 'title'),
      blk('q2', 'g2', 'phone'),
      logic('L', l),
    ]
    expect(logicBlockWarnings(blocks, blocks[4]!)).toEqual([])
  })

  it('цель удалена', () => {
    const out = warn({ then: [{ kind: 'show', targets: ['призрак'] }] })
    expect(out.join(' ')).toContain('удалена')
  })

  it('строка вопроса — законная цель, предупреждения нет', () => {
    // Правило на строке группы прячет её одну — вопрос при этом остаётся.
    expect(warn({ when: { blockId: 'q1', op: 'answered' }, then: [{ kind: 'show', targets: ['q2'] }] })).toEqual([])
  })

  it('обязателен всегда — условие ничего не меняет', () => {
    const blocks = doc().map((b) => (b.id === 'q2' ? { ...b, required: true } : b))
    const l: Block['logic'] = { then: [{ kind: 'require', targets: ['q2'] }] }
    blocks[2] = logic('L', l)
    expect(logicBlockWarnings(blocks, blocks[2]!).join(' ')).toContain('обязателен всегда')
  })

  it('вариант обязательным не бывает', () => {
    const out = warn({ then: [{ kind: 'require', targets: ['o1'] }] })
    expect(out.join(' ')).toContain('обязательным')
  })

  it('переходу некуда вести', () => {
    const out = warn({ then: [{ kind: 'jump', to: 'нет-такого' }] })
    expect(out.join(' ')).toContain('некуда')
  })

  it('одна беда у двух действий — одна строка', () => {
    const out = warn({
      then: [
        { kind: 'show', targets: ['призрак'] },
        { kind: 'hide', targets: ['призрак2'] },
      ],
    })
    expect(out.filter((w) => w.includes('удалена'))).toHaveLength(1)
  })
})
