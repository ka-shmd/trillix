import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'

import {
  JUMP_END,
  jumpTargetsFrom,
  logicBlockWarnings,
  optionTargets,
  requireTargets,
  showTargets,
  targetsByPage,
} from './model'

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

describe('цели действий — весь документ, а не только то, что ниже', () => {
  it('«показать» адресует головы групп, включая стоящие ВЫШЕ блока', () => {
    expect(showTargets(doc()).map((b) => b.id)).toEqual(['q1cap', 'q2cap', 'list'])
  })

  it('«обязателен» адресует все отвечаемые', () => {
    expect(requireTargets(doc()).map((b) => b.id)).toEqual(['q1', 'q2', 'list'])
  })

  it('«варианты» адресуют choice-вопросы', () => {
    expect(optionTargets(doc()).map((b) => b.id)).toEqual(['list'])
  })

  it('сам блок logic целью не бывает', () => {
    const two = [...doc(), logic('L2', {})]
    expect(showTargets(two).map((b) => b.id)).not.toContain('L2')
  })

  it('разрыв страницы и заголовок формы целью показа не бывают', () => {
    const paged: Block[] = [
      { id: 'ft', groupId: 'gft', type: 'form_title' },
      blk('q1cap', 'g1', 'title'),
      blk('br', 'gb', 'page_break'),
      blk('q2cap', 'g2', 'title'),
    ]
    expect(showTargets(paged).map((b) => b.id)).toEqual(['q1cap', 'q2cap'])
  })

  it('цели раскладываются по страницам — так их показывает пикер', () => {
    const paged: Block[] = [
      blk('q1cap', 'g1', 'title'),
      blk('br', 'gb', 'page_break'),
      blk('q2cap', 'g2', 'title'),
    ]
    expect(targetsByPage(paged, showTargets(paged))).toEqual([
      { page: 1, items: [paged[0]] },
      { page: 2, items: [paged[2]] },
    ])
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
      warn({ when: { blockId: 'q1', op: 'answered' }, then: [{ kind: 'show', target: 'q2cap' }] }),
    ).toEqual([])
  })

  it('без действий условие меряется от самого блока', () => {
    const out = warn({ when: { blockId: 'list', op: 'answered' }, then: [] })
    expect(out.join(' ')).toContain('ниже')
  })

  it('источник ниже ЦЕЛИ — правило по этой цели не действует', () => {
    // Источник q2 стоит ниже цели q1cap: к моменту, когда решается цель, он не решён.
    const out = warn({ when: { blockId: 'q2', op: 'answered' }, then: [{ kind: 'show', target: 'q1cap' }] })
    expect(out.join(' ')).toContain('ниже')
  })

  it('цель ВЫШЕ блока предупреждения не даёт — позиция блока не важна', () => {
    // Блок стоит ПОСЛЕДНИМ и прячет вопрос в середине; источник при этом выше цели.
    const l: Block['logic'] = {
      when: { blockId: 'q1', op: 'answered' },
      then: [{ kind: 'show', target: 'q2cap' }],
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
    const out = warn({ then: [{ kind: 'show', target: 'призрак' }] })
    expect(out.join(' ')).toContain('удалена')
  })

  it('цель показа — не голова группы', () => {
    const out = warn({ then: [{ kind: 'show', target: 'q2' }] })
    expect(out.join(' ')).toContain('не первая строка')
  })

  it('обязателен всегда — условие ничего не меняет', () => {
    const blocks = doc().map((b) => (b.id === 'q2' ? { ...b, required: true } : b))
    const l: Block['logic'] = { then: [{ kind: 'require', target: 'q2' }] }
    blocks[2] = logic('L', l)
    expect(logicBlockWarnings(blocks, blocks[2]!).join(' ')).toContain('обязателен всегда')
  })

  it('варианты не выбраны', () => {
    const out = warn({ then: [{ kind: 'hide_options', target: 'list', options: [] }] })
    expect(out.join(' ')).toContain('ни одного варианта')
  })

  it('переходу некуда вести', () => {
    const out = warn({ then: [{ kind: 'jump', to: 'нет-такого' }] })
    expect(out.join(' ')).toContain('некуда')
  })

  it('одна беда у двух действий — одна строка', () => {
    const out = warn({
      then: [
        { kind: 'show', target: 'призрак' },
        { kind: 'hide', target: 'призрак2' },
      ],
    })
    expect(out.filter((w) => w.includes('удалена'))).toHaveLength(1)
  })
})
