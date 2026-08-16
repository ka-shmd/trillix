import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'

import { JUMP_END, jumpTargetsFrom, logicBlockWarnings, optionTargets, requireTargets, showTargets } from './model'

// Редакторская сторона позиционного правила (ADR §10): источники предлагаются ВЫШЕ
// блока, цели — НИЖЕ. Семантику (что правило значит) знает вычислитель и проверяет
// entities/logic.test.ts; здесь — только «что автору вообще предлагают выбрать» и
// «о чём его предупреждают».

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

describe('цели действий предлагаются только НИЖЕ блока', () => {
  it('«показать» адресует головы групп ниже', () => {
    expect(showTargets(doc(), 'L').map((b) => b.id)).toEqual(['q2cap', 'list'])
  })

  it('«обязателен» адресует отвечаемые ниже', () => {
    expect(requireTargets(doc(), 'L').map((b) => b.id)).toEqual(['q2', 'list'])
  })

  it('«варианты» адресуют choice-вопросы ниже', () => {
    expect(optionTargets(doc(), 'L').map((b) => b.id)).toEqual(['list'])
  })

  it('вопрос выше блока в целях не предлагается', () => {
    for (const targets of [showTargets(doc(), 'L'), requireTargets(doc(), 'L')]) {
      expect(targets.map((b) => b.id)).not.toContain('q1')
      expect(targets.map((b) => b.id)).not.toContain('q1cap')
    }
  })

  it('сам блок logic целью не бывает', () => {
    const two = [...doc(), logic('L2', {})]
    expect(showTargets(two, 'L').map((b) => b.id)).not.toContain('L2')
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

  it('источник ниже блока', () => {
    const out = warn({ when: { blockId: 'q2', op: 'answered' }, then: [] })
    expect(out.join(' ')).toContain('ниже')
  })

  it('цель выше блока', () => {
    const out = warn({ when: { blockId: 'q1', op: 'answered' }, then: [{ kind: 'show', target: 'q1cap' }] })
    expect(out.join(' ')).toContain('выше блока')
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
