import { describe, expect, it } from 'vitest'

import {
  type Block,
  type LogicAction,
  type LogicCondition,
  type LogicOperator,
  MAX_LOGIC_ACTIONS,
  MAX_LOGIC_NODES,
  formSchemaSchema,
} from '@entities/formSchema'
import { type Answers, optionVisible, planForm, stripHiddenAnswers } from '@fields/logic'

// Зеркало internal/domain/logic_test.go: ЭТОТ ЖЕ состав случаев проверяется в Go.
// Общего кода между сторонами нет по построению (ADR §10), поэтому паритет держат
// одинаковые таблицы; названия кейсов совпадают, чтобы расхождение было видно диффом.

const blk = (id: string, groupId: string, type: Block['type']): Block => ({ id, groupId, type })

const choice = (
  id: string,
  groupId: string,
  type: Block['type'],
  options: { id: string; label?: string }[],
): Block => ({
  id,
  groupId,
  type,
  settings: { options: options.map((o) => ({ label: '', ...o })) },
})

// showRule/requireRule/optionRule — блок logic с одним действием, СТОЯЩИЙ ПЕРЕД целью:
// источники условия оказываются выше него, цель — ниже. Помощники, а не литералы по
// месту: почти каждый случай ниже про семантику условия, а не про форму блока.
const showRule = (target: string, when?: LogicCondition): Block => ({
  id: `L-show-${target}`,
  groupId: `gL-show-${target}`,
  type: 'logic',
  logic: { when, then: [{ kind: 'show', targets: [target] }] },
})

const requireRule = (target: string, when?: LogicCondition): Block => ({
  id: `L-req-${target}`,
  groupId: `gL-req-${target}`,
  type: 'logic',
  logic: { when, then: [{ kind: 'require', targets: [target] }] },
})

// «Показать варианты»: перечисленные видны только по условию, остальные умолчания не
// меняют.
const optionRule = (target: string, when: LogicCondition, ...options: string[]): Block => ({
  id: `L-opt-${target}-${options[0]}`,
  groupId: `gL-opt-${target}-${options[0]}`,
  type: 'logic',
  logic: { when, then: [{ kind: 'show', targets: options }] },
})

const leaf = (blockId: string, op: LogicOperator, value = ''): LogicCondition => ({
  blockId,
  op,
  ...(value === '' ? {} : { value }),
})

const pageIds = (plan: ReturnType<typeof planForm>): string[][] =>
  plan.pages.map((page) => page.map((b) => b.id))

describe('planForm: видимость вопроса', () => {
  const doc = (rule?: LogicCondition): Block[] => [
    choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
    showRule('cap', rule),
    blk('cap', 'g2', 'title'),
    blk('dep', 'g2', 'short_text'),
    blk('later', 'g3', 'short_text'),
  ]

  const cases: [string, LogicCondition | undefined, Answers, boolean][] = [
    ['правила нет — виден всегда', undefined, {}, true],
    ['is совпал — виден', leaf('src', 'is', 'yes'), { src: 'yes' }, true],
    ['is не совпал — скрыт', leaf('src', 'is', 'yes'), { src: 'no' }, false],
    ['is без ответа — скрыт', leaf('src', 'is', 'yes'), {}, false],
    ['is_not у неотвеченного — виден', leaf('src', 'is_not', 'yes'), {}, true],
    ['is_not совпал — скрыт', leaf('src', 'is_not', 'yes'), { src: 'yes' }, false],
    ['answered — виден при любом ответе', leaf('src', 'answered'), { src: 'no' }, true],
    ['answered без ответа — скрыт', leaf('src', 'answered'), {}, false],
    ['empty без ответа — виден', leaf('src', 'empty'), {}, true],
    ['ссылка на несуществующий блок — инертна', leaf('нет-такого', 'is', 'yes'), { src: 'no' }, true],
    ['ссылка вперёд — инертна', leaf('later', 'is', 'x'), {}, true],
    ['оператор не подходит типу источника — инертен', leaf('src', 'includes', 'yes'), { src: 'no' }, true],
    ['значение не выбрано — инертно', { blockId: 'src', op: 'is', value: '' }, { src: 'no' }, true],
    [
      'all: обе истинны — виден',
      { all: [leaf('src', 'answered'), leaf('src', 'is', 'yes')] },
      { src: 'yes' },
      true,
    ],
    [
      'all: одна ложна — скрыт',
      { all: [leaf('src', 'answered'), leaf('src', 'is', 'yes')] },
      { src: 'no' },
      false,
    ],
    [
      'any: одна истинна — виден',
      { any: [leaf('src', 'is', 'yes'), leaf('src', 'is', 'no')] },
      { src: 'no' },
      true,
    ],
    [
      'any: обе ложны — скрыт',
      { any: [leaf('src', 'is', 'yes'), leaf('src', 'is', 'maybe')] },
      { src: 'no' },
      false,
    ],
    [
      'вложенность: any(all, leaf)',
      {
        any: [{ all: [leaf('src', 'answered'), leaf('src', 'is', 'no')] }, leaf('src', 'is', 'yes')],
      },
      { src: 'no' },
      true,
    ],
    [
      'инертный ребёнок делает инертным всё правило',
      { any: [leaf('src', 'is', 'yes'), leaf('нет-такого', 'is', 'x')] },
      { src: 'no' },
      true,
    ],
  ]

  it.each(cases)('%s', (_name, rule, answers, visible) => {
    const plan = planForm(doc(rule), answers)
    // Правило висит на голове группы и прячет ВСЮ группу, а не только поле.
    expect(plan.visible.has('dep')).toBe(visible)
    expect(plan.visible.has('cap')).toBe(visible)
    expect(plan.visible.has('src')).toBe(true)
  })

  // Два уровня видимости: голова прячет вопрос ЦЕЛИКОМ, любая другая строка группы —
  // только себя (2026-08-16).
  it('правило на строке группы прячет только её, подпись остаётся', () => {
    const blocks: Block[] = [
      choice('src', 'g1', 'single_choice', [{ id: 'yes' }]),
      showRule('dep', leaf('src', 'is', 'yes')),
      blk('cap', 'g2', 'title'),
      blk('dep', 'g2', 'short_text'),
    ]
    const plan = planForm(blocks, { src: 'no' })
    expect(plan.visible.has('dep')).toBe(false)
    expect(plan.visible.has('cap')).toBe(true)
  })

  it('спрятанный вопрос не показывает своих строк', () => {
    const blocks: Block[] = [
      choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
      showRule('cap', leaf('src', 'is', 'yes')),
      {
        id: 'L2',
        groupId: 'gL2',
        type: 'logic',
        logic: { when: leaf('src', 'answered'), then: [{ kind: 'show', targets: ['dep'] }] },
      },
      blk('cap', 'g2', 'title'),
      blk('dep', 'g2', 'short_text'),
    ]
    // Собственное правило строки сработало, правило вопроса — нет.
    expect(planForm(blocks, { src: 'no' }).visible.has('dep')).toBe(false)
  })

  it('скрытый источник считается пустым', () => {
    // Цепочка А → Б → В: скрытый Б не отвечен, значит В тоже скрыт, даже если в
    // присланных ответах на Б что-то есть.
    const blocks: Block[] = [
      choice('a', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
      showRule('b', leaf('a', 'is', 'yes')),
      choice('b', 'g2', 'single_choice', [{ id: 'dog' }]),
      showRule('c', leaf('b', 'is', 'dog')),
      blk('c', 'g3', 'short_text'),
    ]
    const plan = planForm(blocks, { a: 'no', b: 'dog' })
    expect(plan.visible.has('b')).toBe(false)
    expect(plan.visible.has('c')).toBe(false)
  })
})

describe('planForm: обязательность', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'call' }, { id: 'mail' }])

  const cases: [string, boolean, LogicCondition | null, Answers, boolean][] = [
    ['required без условия', true, null, {}, true],
    ['условие обязательности сработало', false, leaf('src', 'is', 'call'), { src: 'call' }, true],
    ['условие обязательности не сработало', false, leaf('src', 'is', 'call'), { src: 'mail' }, false],
    ['условие обязательности инертно — не обязателен', false, leaf('нет-такого', 'is', 'x'), {}, false],
  ]

  it.each(cases)('%s', (_name, flag, rule, answers, required) => {
    const dep: Block = { ...blk('dep', 'g2', 'phone'), required: flag }
    const blocks = rule === null ? [src, dep] : [src, requireRule('dep', rule), dep]
    expect(planForm(blocks, answers).required.has('dep')).toBe(required)
  })

  it('скрытый вопрос не обязателен никогда', () => {
    const dep: Block = { ...blk('dep', 'g2', 'phone'), required: true }
    const blocks = [src, showRule('dep', leaf('src', 'is', 'call')), dep]
    expect(planForm(blocks, { src: 'mail' }).required.has('dep')).toBe(false)
  })
})

describe('planForm: варианты', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'dog' }, { id: 'cat' }])
  const list = choice('list', 'g2', 'multi_choice', [{ id: 'leash' }, { id: 'tray' }, { id: 'food' }])
  const ruled: Block[] = [
    src,
    optionRule('list', leaf('src', 'is', 'dog'), 'leash'),
    optionRule('list', leaf('src', 'is', 'cat'), 'tray'),
    list,
  ]

  it('видны только варианты со сработавшим условием', () => {
    const plan = planForm(ruled, { src: 'dog' })
    expect(optionVisible(plan, 'list', 'leash')).toBe(true)
    expect(optionVisible(plan, 'list', 'tray')).toBe(false)
    expect(optionVisible(plan, 'list', 'food')).toBe(true)
  })

  it('у блока без правил карты вариантов нет — видны все', () => {
    const plan = planForm([src], {})
    expect(plan.options.has('src')).toBe(false)
    expect(optionVisible(plan, 'src', 'dog')).toBe(true)
  })

  it('выбранный скрытый вариант не считается выбором', () => {
    const dep = blk('dep', 'g3', 'short_text')
    const blocks = [...ruled, showRule('dep', leaf('list', 'includes', 'tray')), dep]
    const plan = planForm(blocks, { src: 'dog', list: ['tray', 'food'] })
    expect(plan.visible.has('dep')).toBe(false)
  })

  it('includes по видимому варианту работает', () => {
    const dep = blk('dep', 'g3', 'short_text')
    const blocks = [...ruled, showRule('dep', leaf('list', 'includes', 'leash')), dep]
    const plan = planForm(blocks, { src: 'dog', list: ['leash'] })
    expect(plan.visible.has('dep')).toBe(true)
  })
})

describe('planForm: числа', () => {
  const scale: Block = {
    ...blk('nps', 'g1', 'scale'),
    settings: { scaleMin: 0, scaleMax: 10 },
  }
  const num = blk('age', 'g2', 'number')
  const txt = blk('txt', 'g3', 'short_text')

  const cases: [string, LogicCondition, Answers, boolean][] = [
    ['gt по шкале', leaf('nps', 'gt', '8'), { nps: '9' }, true],
    ['gt по шкале не сработал', leaf('nps', 'gt', '8'), { nps: '8' }, false],
    ['lt по шкале', leaf('nps', 'lt', '5'), { nps: '3' }, true],
    ['is у number сравнивает числом, а не строкой', leaf('age', 'is', '5.0'), { age: '5' }, true],
    ['gt у нечислового ответа — ложь, но правило действует', leaf('age', 'gt', '5'), { age: 'abc' }, false],
    ['gt у текстового источника — инертен', leaf('txt', 'gt', '5'), {}, true],
  ]

  it.each(cases)('%s', (_name, rule, answers, visible) => {
    const dep = blk('dep', 'g4', 'short_text')
    const blocks = [scale, num, txt, showRule('dep', rule), dep]
    expect(planForm(blocks, answers).visible.has('dep')).toBe(visible)
  })
})

describe('planForm: страницы и переходы', () => {
  // Три страницы: [src] | [q2] | [q3]; разрывы br1 и br2.
  // Переходы приезжают блоком logic на ПЕРВОЙ странице: правило принадлежит странице,
  // с которой уходят.
  const paged = (...jumps: LogicAction[]): Block[] => [
    choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
    ...(jumps.length > 0
      ? [
          {
            id: 'L',
            groupId: 'gL',
            type: 'logic' as const,
            logic: { when: leaf('src', 'is', 'no'), then: jumps },
          },
        ]
      : []),
    blk('br1', 'gb1', 'page_break'),
    blk('q2', 'g2', 'short_text'),
    blk('br2', 'gb2', 'page_break'),
    blk('q3', 'g3', 'short_text'),
  ]

  it('без переходов страницы идут подряд', () => {
    expect(pageIds(planForm(paged(), {}))).toEqual([['src'], ['q2'], ['q3']])
  })

  it('переход вперёд пропускает страницу', () => {
    const plan = planForm(paged({ kind: 'jump', to: 'br2' }), { src: 'no' })
    expect(pageIds(plan)).toEqual([['src'], ['q3']])
    expect(plan.visible.has('q2')).toBe(false)
  })

  it('условие перехода не сработало — идём подряд', () => {
    const plan = planForm(paged({ kind: 'jump', to: 'br2' }), { src: 'yes' })
    expect(plan.pages).toHaveLength(3)
  })

  it('end обрывает форму на текущей странице', () => {
    const plan = planForm(paged({ kind: 'jump', end: true }), { src: 'no' })
    expect(pageIds(plan)).toEqual([['src']])
  })

  it('переход назад инертен', () => {
    // Правило стоит на ВТОРОЙ странице и ведёт на первую — назад.
    const blocks = paged()
    blocks.splice(2, 0, {
      id: 'L',
      groupId: 'gL',
      type: 'logic',
      logic: { when: leaf('src', 'is', 'no'), then: [{ kind: 'jump', to: 'br1' }] },
    })
    expect(pageIds(planForm(blocks, { src: 'no' }))).toEqual([['src'], ['q2'], ['q3']])
  })

  it('переход в никуда инертен', () => {
    const plan = planForm(paged({ kind: 'jump', to: 'нет-такого' }), { src: 'no' })
    expect(plan.pages).toHaveLength(3)
  })

  it('выигрывает первое сработавшее правило', () => {
    const plan = planForm(paged({ kind: 'jump', to: 'br2' }, { kind: 'jump', end: true }), {
      src: 'no',
    })
    expect(pageIds(plan)).toEqual([['src'], ['q3']])
  })

  it('страница, где скрыто всё, не показывается', () => {
    const blocks = paged()
    blocks.splice(2, 0, showRule('q2', leaf('src', 'is', 'yes')))
    expect(pageIds(planForm(blocks, { src: 'no' }))).toEqual([['src'], ['q3']])
  })

  it('страница на выходе всегда хотя бы одна', () => {
    expect(planForm([], {}).pages).toHaveLength(1)
  })

  it('условие смотрит на вопрос той же страницы', () => {
    const blocks = paged()
    blocks.splice(1, 0, showRule('dep', leaf('src', 'is', 'yes')), blk('dep', 'g4', 'short_text'))
    expect(planForm(blocks, { src: 'yes' }).visible.has('dep')).toBe(true)
  })
})

// ---------- правила из блока `logic` (зеркало TestPlanForm_LogicBlock*) ----------

describe('planForm: блок logic — показ и скрытие', () => {
  const logic = (id: string, groupId: string, l: Block['logic']): Block => ({
    id,
    groupId,
    type: 'logic',
    logic: l,
  })

  // [src] [L] [cap dep] — цель стоит НИЖЕ блока, источник ВЫШЕ него.
  const doc = (l: Block['logic']): Block[] => [
    choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
    logic('L', 'gL', l),
    blk('cap', 'g2', 'title'),
    blk('dep', 'g2', 'short_text'),
  ]

  const cases: [string, Block['logic'], Answers, boolean][] = [
    [
      'show: сработало — показан',
      { when: leaf('src', 'is', 'yes'), then: [{ kind: 'show', targets: ['cap'] }] },
      { src: 'yes' },
      true,
    ],
    [
      'show: не сработало — скрыт (умолчание перевёрнуто)',
      { when: leaf('src', 'is', 'yes'), then: [{ kind: 'show', targets: ['cap'] }] },
      { src: 'no' },
      false,
    ],
    [
      'hide: сработало — скрыт',
      { when: leaf('src', 'is', 'yes'), then: [{ kind: 'hide', targets: ['cap'] }] },
      { src: 'yes' },
      false,
    ],
    [
      'hide: не сработало — виден',
      { when: leaf('src', 'is', 'yes'), then: [{ kind: 'hide', targets: ['cap'] }] },
      { src: 'no' },
      true,
    ],
    [
      'блок без условия инертен',
      { then: [{ kind: 'show', targets: ['cap'] }] },
      { src: 'no' },
      true,
    ],
    [
      'блок без действий ничего не делает',
      { when: leaf('src', 'is', 'yes') },
      { src: 'no' },
      true,
    ],
    [
      'действие на удалённую цель инертно',
      { when: leaf('src', 'is', 'yes'), then: [{ kind: 'show', targets: ['призрак'] }] },
      { src: 'no' },
      true,
    ],
    [
      'источник НИЖЕ цели — правило инертно',
      { when: leaf('dep', 'answered'), then: [{ kind: 'show', targets: ['cap'] }] },
      {},
      true,
    ],
    [
      'ссылка на несуществующий источник инертна',
      { when: leaf('нет-такого', 'is', 'x'), then: [{ kind: 'show', targets: ['cap'] }] },
      {},
      true,
    ],
  ]

  it.each(cases)('%s', (_name, l, answers, visible) => {
    const plan = planForm(doc(l), answers)
    // Действие адресует ГОЛОВУ группы и прячет вопрос целиком.
    expect(plan.visible.has('dep')).toBe(visible)
    expect(plan.visible.has('cap')).toBe(visible)
  })

  // Блок волен стоять ГДЕ УГОДНО, в том числе ниже того, что прячет: обходу важно лишь
  // то, что источник решён к моменту, когда решается цель (ADR §10, 2026-08-16).
  it('блок стоит НИЖЕ цели — действие работает', () => {
    const blocks: Block[] = [
      choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
      blk('cap', 'g2', 'title'),
      blk('dep', 'g2', 'short_text'),
      logic('L', 'gL', { when: leaf('src', 'is', 'yes'), then: [{ kind: 'show', targets: ['cap'] }] }),
    ]
    expect(planForm(blocks, { src: 'no' }).visible.has('dep')).toBe(false)
    expect(planForm(blocks, { src: 'yes' }).visible.has('dep')).toBe(true)
  })

  it('источник стоит НИЖЕ цели — правило инертно', () => {
    const blocks: Block[] = [
      blk('cap', 'g1', 'title'),
      blk('dep', 'g1', 'short_text'),
      choice('src', 'g2', 'single_choice', [{ id: 'yes' }]),
      logic('L', 'gL', { when: leaf('src', 'is', 'yes'), then: [{ kind: 'show', targets: ['cap'] }] }),
    ]
    expect(planForm(blocks, { src: 'no' }).visible.has('dep')).toBe(true)
  })

  it('скрыть побеждает показать', () => {
    const blocks: Block[] = [
      choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
      logic('L1', 'gL1', { when: leaf('src', 'answered'), then: [{ kind: 'show', targets: ['cap'] }] }),
      logic('L2', 'gL2', { when: leaf('src', 'is', 'yes'), then: [{ kind: 'hide', targets: ['cap'] }] }),
      blk('cap', 'g2', 'title'),
      blk('dep', 'g2', 'short_text'),
    ]
    expect(planForm(blocks, { src: 'yes' }).visible.has('dep')).toBe(false)
    expect(planForm(blocks, { src: 'no' }).visible.has('dep')).toBe(true)
  })

  it('порядок блоков logic между собой на результат не влияет', () => {
    const src = choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }])
    const a = logic('L1', 'gL1', {
      when: leaf('src', 'is', 'yes'),
      then: [{ kind: 'show', targets: ['cap'] }],
    })
    const b = logic('L2', 'gL2', {
      when: leaf('src', 'is', 'no'),
      then: [{ kind: 'show', targets: ['cap'] }],
    })
    const tail = [blk('cap', 'g2', 'title'), blk('dep', 'g2', 'short_text')]
    for (const answers of [{ src: 'yes' }, { src: 'no' }, {}]) {
      expect(planForm([src, a, b, ...tail], answers).visible.has('dep')).toBe(
        planForm([src, b, a, ...tail], answers).visible.has('dep'),
      )
    }
  })

  it('несколько «показать» на одну цель складываются по ИЛИ', () => {
    const src = choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }])
    const blocks: Block[] = [
      src,
      logic('L1', 'gL1', { when: leaf('src', 'is', 'yes'), then: [{ kind: 'show', targets: ['cap'] }] }),
      logic('L2', 'gL2', { when: leaf('src', 'is', 'no'), then: [{ kind: 'show', targets: ['cap'] }] }),
      blk('cap', 'g2', 'title'),
      blk('dep', 'g2', 'short_text'),
    ]
    expect(planForm(blocks, { src: 'yes' }).visible.has('dep')).toBe(true)
    expect(planForm(blocks, { src: 'no' }).visible.has('dep')).toBe(true)
    expect(planForm(blocks, {}).visible.has('dep')).toBe(false)
  })

  it('одно условие раздаёт несколько действий', () => {
    const blocks: Block[] = [
      choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
      logic('L', 'gL', {
        when: leaf('src', 'is', 'yes'),
        then: [
          { kind: 'show', targets: ['cap'] },
          { kind: 'require', targets: ['dep'] },
        ],
      }),
      blk('cap', 'g2', 'title'),
      blk('dep', 'g2', 'short_text'),
    ]
    const plan = planForm(blocks, { src: 'yes' })
    expect(plan.visible.has('dep')).toBe(true)
    expect(plan.required.has('dep')).toBe(true)
  })

  it('блок logic не попадает ни в видимые, ни на страницу', () => {
    const plan = planForm(doc({ when: leaf('src', 'is', 'yes') }), { src: 'yes' })
    expect(plan.visible.has('L')).toBe(false)
    expect(pageIds(plan)).toEqual([['src', 'cap', 'dep']])
  })
})

describe('planForm: блок logic — обязательность', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'call' }, { id: 'mail' }])
  const rule = (then: NonNullable<Block['logic']>['then']): Block => ({
    id: 'L',
    groupId: 'gL',
    type: 'logic',
    logic: { when: leaf('src', 'is', 'call'), then },
  })

  it('действие сработало — обязателен', () => {
    const blocks = [src, rule([{ kind: 'require', targets: ['dep'] }]), blk('dep', 'g2', 'phone')]
    expect(planForm(blocks, { src: 'call' }).required.has('dep')).toBe(true)
    expect(planForm(blocks, { src: 'mail' }).required.has('dep')).toBe(false)
  })

  it('флаг required и действие складываются по ИЛИ', () => {
    const dep: Block = { ...blk('dep', 'g2', 'phone'), required: true }
    const blocks = [src, rule([{ kind: 'require', targets: ['dep'] }]), dep]
    expect(planForm(blocks, { src: 'mail' }).required.has('dep')).toBe(true)
  })

  it('скрытый вопрос не обязателен никогда', () => {
    const blocks: Block[] = [
      src,
      rule([
        { kind: 'hide', targets: ['dep'] },
        { kind: 'require', targets: ['dep'] },
      ]),
      blk('dep', 'g2', 'phone'),
    ]
    expect(planForm(blocks, { src: 'call' }).required.has('dep')).toBe(false)
  })
})

describe('planForm: блок logic — варианты', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'dog' }, { id: 'cat' }])
  const list = choice('list', 'g2', 'multi_choice', [{ id: 'leash' }, { id: 'tray' }, { id: 'food' }])
  const rule = (then: NonNullable<Block['logic']>['then']): Block => ({
    id: 'L',
    groupId: 'gL',
    type: 'logic',
    logic: { when: leaf('src', 'is', 'dog'), then },
  })

  it('«скрыть варианты» прячет названные', () => {
    const blocks = [src, rule([{ kind: 'hide', targets: ['tray'] }]), list]
    const plan = planForm(blocks, { src: 'dog' })
    expect(optionVisible(plan, 'list', 'tray')).toBe(false)
    expect(optionVisible(plan, 'list', 'leash')).toBe(true)
    expect(optionVisible(plan, 'list', 'food')).toBe(true)
  })

  it('«показать варианты» переворачивает умолчание названных', () => {
    const blocks = [src, rule([{ kind: 'show', targets: ['leash'] }]), list]
    expect(optionVisible(planForm(blocks, { src: 'cat' }), 'list', 'leash')).toBe(false)
    expect(optionVisible(planForm(blocks, { src: 'dog' }), 'list', 'leash')).toBe(true)
    // Не названный вариант умолчания не менял.
    expect(optionVisible(planForm(blocks, { src: 'cat' }), 'list', 'food')).toBe(true)
  })

  it('скрытый вариант не считается выбором', () => {
    const dep = blk('dep', 'g3', 'short_text')
    const blocks = [
      src,
      rule([{ kind: 'hide', targets: ['tray'] }]),
      list,
      showRule('dep', leaf('list', 'includes', 'tray')),
      dep,
    ]
    const plan = planForm(blocks, { src: 'dog', list: ['tray', 'food'] })
    expect(plan.visible.has('dep')).toBe(false)
  })
})

describe('planForm: блок logic — переход и кнопка', () => {
  // Три страницы: [src, L] | [q2] | [q3].
  const paged = (then: NonNullable<Block['logic']>['then'], when = leaf('src', 'is', 'no')): Block[] => [
    choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
    { id: 'L', groupId: 'gL', type: 'logic', logic: { when, then } },
    blk('br1', 'gb1', 'page_break'),
    blk('q2', 'g2', 'short_text'),
    blk('br2', 'gb2', 'page_break'),
    blk('q3', 'g3', 'short_text'),
  ]

  it('переход со СВОЕЙ страницы пропускает следующую', () => {
    const plan = planForm(paged([{ kind: 'jump', to: 'br2' }]), { src: 'no' })
    expect(pageIds(plan)).toEqual([['src'], ['q3']])
  })

  it('условие не сработало — идём подряд', () => {
    expect(planForm(paged([{ kind: 'jump', to: 'br2' }]), { src: 'yes' }).pages).toHaveLength(3)
  })

  it('end обрывает форму на текущей странице', () => {
    expect(pageIds(planForm(paged([{ kind: 'jump', end: true }]), { src: 'no' }))).toEqual([['src']])
  })

  it('переход назад инертен', () => {
    const blocks = paged([{ kind: 'jump', to: 'br1' }])
    expect(planForm(blocks, { src: 'no' }).pages).toHaveLength(3)
  })

  it('«скрыть кнопку» обрывает обход и помечает план', () => {
    const plan = planForm(paged([{ kind: 'block_submit' }]), { src: 'no' })
    expect(plan.blocked).toBe(true)
    expect(pageIds(plan)).toEqual([['src']])
  })

  it('«скрыть кнопку» не сработало — план не заблокирован', () => {
    const plan = planForm(paged([{ kind: 'block_submit' }]), { src: 'yes' })
    expect(plan.blocked).toBe(false)
    expect(plan.pages).toHaveLength(3)
  })

  it('«скрыть кнопку» старше перехода с той же страницы', () => {
    const plan = planForm(
      paged([
        { kind: 'jump', to: 'br2' },
        { kind: 'block_submit' },
      ]),
      { src: 'no' },
    )
    expect(plan.blocked).toBe(true)
    expect(pageIds(plan)).toEqual([['src']])
  })

  it('форма без блоков logic не заблокирована', () => {
    expect(planForm([blk('q', 'g1', 'short_text')], {}).blocked).toBe(false)
  })
})

describe('stripHiddenAnswers', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }])
  const dep = blk('dep', 'g2', 'short_text')
  const list = choice('list', 'g3', 'multi_choice', [{ id: 'a' }, { id: 'b' }])
  const single = choice('single', 'g4', 'dropdown', [{ id: 'x' }, { id: 'y' }])
  const yes = leaf('src', 'is', 'yes')
  const blocks = [
    src,
    showRule('dep', yes),
    dep,
    optionRule('list', yes, 'a'),
    list,
    optionRule('single', yes, 'x'),
    single,
  ]

  it('ответ на скрытый вопрос отброшен', () => {
    const out = stripHiddenAnswers(blocks, { src: 'no', dep: 'Барсик' })
    expect(out).toEqual({ src: 'no' })
  })

  it('скрытый вариант вычищен из множественного выбора', () => {
    const out = stripHiddenAnswers(blocks, { src: 'no', list: ['a', 'b'] })
    expect(out.list).toEqual(['b'])
  })

  it('скрытый вариант одиночного выбора уносит весь ответ', () => {
    const out = stripHiddenAnswers(blocks, { src: 'no', single: 'x' })
    expect(out.single).toBeUndefined()
  })

  it('ответ на несуществующий блок не трогается', () => {
    // Нарушение контракта ловит валидация ответа, а не нормализация.
    expect(stripHiddenAnswers(blocks, { призрак: 'x' })).toEqual({ призрак: 'x' })
  })

  it('вход не мутируется', () => {
    const input: Answers = { src: 'no', dep: 'Барсик' }
    stripHiddenAnswers(blocks, input)
    expect(input.dep).toBe('Барсик')
  })

  it('инвариант: план по очищенным ответам совпадает с исходным', () => {
    const samples: Answers[] = [
      { src: 'yes', dep: 'Барсик', list: ['a', 'b'], single: 'x' },
      { src: 'no', dep: 'Барсик', list: ['a', 'b'], single: 'x' },
      { src: 'no' },
      {},
    ]
    for (const a of samples) {
      const before = planForm(blocks, a)
      const after = planForm(blocks, stripHiddenAnswers(blocks, a))
      expect([...after.visible].sort()).toEqual([...before.visible].sort())
      expect([...after.required].sort()).toEqual([...before.required].sort())
      expect(pageIds(after)).toEqual(pageIds(before))
    }
  })
})

// ---------- форма правил в схеме (зеркало TestValidateSchema_Logic*) ----------

const doc = (blocks: unknown[]): unknown => ({ schemaVersion: 1, blocks })

describe('схема: форма правил', () => {
  const valid: [string, unknown][] = [
    [
      'условие листом',
      doc([
        { id: 'a', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'Да' }] } },
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: { when: { blockId: 'a', op: 'is', value: 'o1' }, then: [{ kind: 'show', targets: ['b'] }] },
        },
        { id: 'b', groupId: 'g2', type: 'short_text' },
      ]),
    ],
    [
      'условие вложенными группами',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: {
            when: {
              any: [
                { all: [{ blockId: 'a', op: 'answered' }, { blockId: 'a', op: 'is', value: 'x' }] },
                { blockId: 'a', op: 'is', value: 'y' },
              ],
            },
          },
        },
      ]),
    ],
    [
      'значение не выбрано — законный черновик',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        { id: 'L', groupId: 'gL', type: 'logic', logic: { when: { blockId: 'a', op: 'is', value: '' } } },
      ]),
    ],
    [
      'ссылка вперёд — инертна, но валидна',
      doc([
        { id: 'L', groupId: 'gL', type: 'logic', logic: { when: { blockId: 'a', op: 'answered' } } },
        { id: 'a', groupId: 'g1', type: 'short_text' },
      ]),
    ],
    [
      'ссылка на удалённый блок — инертна, но валидна',
      doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: { blockId: 'призрак', op: 'answered' } } }]),
    ],
    [
      'обязательность по условию',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: { when: { blockId: 'a', op: 'answered' }, then: [{ kind: 'require', targets: ['b'] }] },
        },
        { id: 'b', groupId: 'g2', type: 'phone' },
      ]),
    ],
    [
      'скрытие варианта',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: {
            when: { blockId: 'a', op: 'is', value: 'dog' },
            then: [{ kind: 'hide', targets: ['o1'] }],
          },
        },
        {
          id: 'b',
          groupId: 'g2',
          type: 'multi_choice',
          settings: { options: [{ id: 'o1', label: 'Поводок' }] },
        },
      ]),
    ],
    [
      'переходы блоком',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: {
            when: { blockId: 'a', op: 'empty' },
            then: [
              { kind: 'jump', to: 'br2' },
              { kind: 'jump', end: true },
            ],
          },
        },
        { id: 'br', groupId: 'g2', type: 'page_break' },
        { id: 'c', groupId: 'g3', type: 'short_text' },
      ]),
    ],
    [
      'глубина ровно в лимит',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: { when: { all: [{ any: [{ all: [{ blockId: 'a', op: 'answered' }] }] }] } },
        },
      ]),
    ],
    [
      'блок logic: условие и все виды действий',
      doc([
        { id: 'a', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'Да' }] } },
        {
          id: 'L',
          groupId: 'g2',
          type: 'logic',
          logic: {
            when: { blockId: 'a', op: 'is', value: 'o1' },
            then: [
              { kind: 'show', targets: ['b'] },
              { kind: 'hide', targets: ['c'] },
              { kind: 'require', targets: ['b'] },
              { kind: 'show', targets: ['o2'] },
              { kind: 'hide', targets: ['o2', 'o3'] },
              { kind: 'jump', to: 'br' },
              { kind: 'jump', end: true },
              { kind: 'block_submit' },
            ],
          },
        },
        { id: 'b', groupId: 'g3', type: 'short_text' },
        { id: 'c', groupId: 'g4', type: 'multi_choice' },
      ]),
    ],
    [
      'блок logic без условия и без действий — законный черновик',
      doc([{ id: 'L', groupId: 'g1', type: 'logic', logic: {} }]),
    ],
    ['блок logic вовсе без поля logic', doc([{ id: 'L', groupId: 'g1', type: 'logic' }])],
    [
      'действие на удалённую цель — инертно, но валидно',
      doc([
        { id: 'L', groupId: 'g1', type: 'logic', logic: { then: [{ kind: 'show', targets: ['призрак'] }] } },
      ]),
    ],
    [
      'цель СТОИТ ВЫШЕ блока — инертно, но валидно',
      doc([
        { id: 'b', groupId: 'g1', type: 'short_text' },
        { id: 'L', groupId: 'g2', type: 'logic', logic: { then: [{ kind: 'show', targets: ['b'] }] } },
      ]),
    ],
  ]

  it.each(valid)('валиден: %s', (_name, document) => {
    expect(formSchemaSchema.safeParse(document).success).toBe(true)
  })

  const deep = { all: [{ all: [{ all: [{ all: [{ blockId: 'a', op: 'answered' }] }] }] }] }
  const invalid: [string, unknown][] = [
    ['пустое условие', doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: {} } }])],
    ['пустая группа', doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: { all: [] } } }])],
    [
      'all и any одновременно',
      doc([
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: { when: { all: [{ blockId: 'a', op: 'answered' }], any: [{ blockId: 'a', op: 'empty' }] } },
        },
      ]),
    ],
    [
      'группа с полями листа',
      doc([
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: { when: { all: [{ blockId: 'a', op: 'answered' }], blockId: 'a', op: 'is', value: 'x' } },
        },
      ]),
    ],
    [
      'неизвестный оператор',
      doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: { blockId: 'a', op: 'matches', value: 'x' } } }]),
    ],
    ['оператора нет вовсе', doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: { blockId: 'a' } } }])],
    [
      'пустой blockId',
      doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: { blockId: '', op: 'answered' } } }]),
    ],
    [
      'значение у answered',
      doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: { blockId: 'a', op: 'answered', value: 'x' } } }]),
    ],
    [
      'значение длиннее лимита',
      doc([
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: { when: { blockId: 'a', op: 'is', value: 'я'.repeat(201) } },
        },
      ]),
    ],
    ['вложенность глубже лимита', doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: deep } }])],
    [
      'лишний ключ в условии',
      doc([
        {
          id: 'L',
          groupId: 'gL',
          type: 'logic',
          logic: { when: { blockId: 'a', op: 'is', value: 'x', not: true } },
        },
      ]),
    ],
    [
      'старое поле visibleIf в документе',
      doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: { blockId: 'a', op: 'answered' } }]),
    ],
    [
      'старое поле requiredIf в документе',
      doc([{ id: 'b', groupId: 'g1', type: 'short_text', requiredIf: { blockId: 'a', op: 'answered' } }]),
    ],
    [
      'старое поле jumpIf в документе',
      doc([{ id: 'br', groupId: 'g1', type: 'page_break', jumpIf: [{ end: true }] }]),
    ],
    [
      'старое поле visibleIf у варианта',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'multi_choice',
          settings: { options: [{ id: 'o1', label: 'Раз', visibleIf: { blockId: 'a', op: 'answered' } }] },
        },
      ]),
    ],
    [
      'logic у чужого типа',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          logic: { then: [{ kind: 'show', targets: ['c'] }] },
        },
      ]),
    ],
    [
      'неизвестное действие',
      doc([{ id: 'L', groupId: 'g1', type: 'logic', logic: { then: [{ kind: 'calculate', target: 'b' }] } }]),
    ],
    [
      'действие без цели',
      doc([{ id: 'L', groupId: 'g1', type: 'logic', logic: { then: [{ kind: 'show' }] } }]),
    ],
    [
      'пустая цель',
      doc([{ id: 'L', groupId: 'g1', type: 'logic', logic: { then: [{ kind: 'show', target: '' }] } }]),
    ],
    [
      'варианты без списка',
      doc([
        { id: 'L', groupId: 'g1', type: 'logic', logic: { then: [{ kind: 'hide_options', target: 'c' }] } },
      ]),
    ],
    [
      'пустой список вариантов',
      doc([
        {
          id: 'L',
          groupId: 'g1',
          type: 'logic',
          logic: { then: [{ kind: 'hide', targets: [] }] },
        },
      ]),
    ],
    [
      'варианты у действия, которое их не адресует',
      doc([
        {
          id: 'L',
          groupId: 'g1',
          type: 'logic',
          logic: { then: [{ kind: 'show', target: 'c', options: ['o1'] }] },
        },
      ]),
    ],
    [
      'переход в блоке logic без цели',
      doc([{ id: 'L', groupId: 'g1', type: 'logic', logic: { then: [{ kind: 'jump' }] } }]),
    ],
    [
      'переход в блоке logic с двумя целями',
      doc([
        {
          id: 'L',
          groupId: 'g1',
          type: 'logic',
          logic: { then: [{ kind: 'jump', to: 'br', end: true }] },
        },
      ]),
    ],
    [
      'цель перехода у действия, которое не переход',
      doc([
        { id: 'L', groupId: 'g1', type: 'logic', logic: { then: [{ kind: 'block_submit', to: 'br' }] } },
      ]),
    ],
    [
      'лишний ключ в блоке logic',
      doc([{ id: 'L', groupId: 'g1', type: 'logic', logic: { when: undefined, otherwise: [] } }]),
    ],
    [
      'действий больше лимита',
      doc([
        {
          id: 'L',
          groupId: 'g1',
          type: 'logic',
          logic: {
            then: Array.from({ length: MAX_LOGIC_ACTIONS + 1 }, () => ({ kind: 'show', targets: ['b'] })),
          },
        },
      ]),
    ],
  ]

  it.each(invalid)('отвергается: %s', (_name, document) => {
    expect(formSchemaSchema.safeParse(document).success).toBe(false)
  })

  it('лимит числа узлов считает правило целиком', () => {
    const leaves = Array.from({ length: MAX_LOGIC_NODES }, () => ({ blockId: 'a', op: 'answered' }))
    const rule = (n: number): unknown =>
      doc([{ id: 'L', groupId: 'gL', type: 'logic', logic: { when: { all: leaves.slice(0, n) } } }])
    expect(formSchemaSchema.safeParse(rule(MAX_LOGIC_NODES - 1)).success).toBe(true)
    expect(formSchemaSchema.safeParse(rule(MAX_LOGIC_NODES)).success).toBe(false)
  })
})
