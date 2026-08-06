import { describe, expect, it } from 'vitest'

import {
  type Block,
  type LogicCondition,
  type LogicOperator,
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
  options: { id: string; label?: string; visibleIf?: LogicCondition }[],
): Block => ({
  id,
  groupId,
  type,
  settings: { options: options.map((o) => ({ label: '', ...o })) },
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
    { ...blk('cap', 'g2', 'title'), visibleIf: rule },
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

  it('правило на не головном блоке группы инертно', () => {
    const blocks: Block[] = [
      choice('src', 'g1', 'single_choice', [{ id: 'yes' }]),
      blk('cap', 'g2', 'title'),
      { ...blk('dep', 'g2', 'short_text'), visibleIf: leaf('src', 'is', 'yes') },
    ]
    const plan = planForm(blocks, { src: 'no' })
    expect(plan.visible.has('dep')).toBe(true)
    expect(plan.visible.has('cap')).toBe(true)
  })

  it('скрытый источник считается пустым', () => {
    // Цепочка А → Б → В: скрытый Б не отвечен, значит В тоже скрыт, даже если в
    // присланных ответах на Б что-то есть.
    const blocks: Block[] = [
      choice('a', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
      {
        ...choice('b', 'g2', 'single_choice', [{ id: 'dog' }]),
        visibleIf: leaf('a', 'is', 'yes'),
      },
      { ...blk('c', 'g3', 'short_text'), visibleIf: leaf('b', 'is', 'dog') },
    ]
    const plan = planForm(blocks, { a: 'no', b: 'dog' })
    expect(plan.visible.has('b')).toBe(false)
    expect(plan.visible.has('c')).toBe(false)
  })
})

describe('planForm: обязательность', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'call' }, { id: 'mail' }])

  const cases: [string, Partial<Block>, Answers, boolean][] = [
    ['required без условия', { required: true }, {}, true],
    ['requiredIf сработал', { requiredIf: leaf('src', 'is', 'call') }, { src: 'call' }, true],
    ['requiredIf не сработал', { requiredIf: leaf('src', 'is', 'call') }, { src: 'mail' }, false],
    ['requiredIf инертен — не обязателен', { requiredIf: leaf('нет-такого', 'is', 'x') }, {}, false],
  ]

  it.each(cases)('%s', (_name, patch, answers, required) => {
    const dep: Block = { ...blk('dep', 'g2', 'phone'), ...patch }
    expect(planForm([src, dep], answers).required.has('dep')).toBe(required)
  })

  it('скрытый вопрос не обязателен никогда', () => {
    const dep: Block = {
      ...blk('dep', 'g2', 'phone'),
      required: true,
      visibleIf: leaf('src', 'is', 'call'),
    }
    expect(planForm([src, dep], { src: 'mail' }).required.has('dep')).toBe(false)
  })
})

describe('planForm: варианты', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'dog' }, { id: 'cat' }])
  const list = choice('list', 'g2', 'multi_choice', [
    { id: 'leash', visibleIf: leaf('src', 'is', 'dog') },
    { id: 'tray', visibleIf: leaf('src', 'is', 'cat') },
    { id: 'food' },
  ])

  it('видны только варианты со сработавшим условием', () => {
    const plan = planForm([src, list], { src: 'dog' })
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
    const dep: Block = { ...blk('dep', 'g3', 'short_text'), visibleIf: leaf('list', 'includes', 'tray') }
    const plan = planForm([src, list, dep], { src: 'dog', list: ['tray', 'food'] })
    expect(plan.visible.has('dep')).toBe(false)
  })

  it('includes по видимому варианту работает', () => {
    const dep: Block = { ...blk('dep', 'g3', 'short_text'), visibleIf: leaf('list', 'includes', 'leash') }
    const plan = planForm([src, list, dep], { src: 'dog', list: ['leash'] })
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
    const dep: Block = { ...blk('dep', 'g4', 'short_text'), visibleIf: rule }
    expect(planForm([scale, num, txt, dep], answers).visible.has('dep')).toBe(visible)
  })
})

describe('planForm: страницы и переходы', () => {
  // Три страницы: [src] | [q2] | [q3]; разрывы br1 и br2.
  const paged = (jumpIf?: Block['jumpIf']): Block[] => [
    choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }]),
    { ...blk('br1', 'gb1', 'page_break'), jumpIf },
    blk('q2', 'g2', 'short_text'),
    blk('br2', 'gb2', 'page_break'),
    blk('q3', 'g3', 'short_text'),
  ]

  it('без переходов страницы идут подряд', () => {
    expect(pageIds(planForm(paged(), {}))).toEqual([['src'], ['q2'], ['q3']])
  })

  it('переход вперёд пропускает страницу', () => {
    const plan = planForm(paged([{ when: leaf('src', 'is', 'no'), to: 'br2' }]), { src: 'no' })
    expect(pageIds(plan)).toEqual([['src'], ['q3']])
    expect(plan.visible.has('q2')).toBe(false)
  })

  it('условие перехода не сработало — идём подряд', () => {
    const plan = planForm(paged([{ when: leaf('src', 'is', 'no'), to: 'br2' }]), { src: 'yes' })
    expect(plan.pages).toHaveLength(3)
  })

  it('end обрывает форму на текущей странице', () => {
    const plan = planForm(paged([{ when: leaf('src', 'is', 'no'), end: true }]), { src: 'no' })
    expect(pageIds(plan)).toEqual([['src']])
  })

  it('переход назад инертен', () => {
    const blocks = paged()
    blocks[3] = { ...blocks[3]!, jumpIf: [{ when: leaf('src', 'is', 'no'), to: 'br1' }] }
    expect(pageIds(planForm(blocks, { src: 'no' }))).toEqual([['src'], ['q2'], ['q3']])
  })

  it('переход в никуда инертен', () => {
    const plan = planForm(paged([{ when: leaf('src', 'is', 'no'), to: 'нет-такого' }]), { src: 'no' })
    expect(plan.pages).toHaveLength(3)
  })

  it('выигрывает первое сработавшее правило', () => {
    const plan = planForm(
      paged([
        { when: leaf('src', 'is', 'no'), to: 'br2' },
        { when: leaf('src', 'answered'), end: true },
      ]),
      { src: 'no' },
    )
    expect(pageIds(plan)).toEqual([['src'], ['q3']])
  })

  it('страница, где скрыто всё, не показывается', () => {
    const blocks = paged()
    blocks[2] = { ...blocks[2]!, visibleIf: leaf('src', 'is', 'yes') }
    expect(pageIds(planForm(blocks, { src: 'no' }))).toEqual([['src'], ['q3']])
  })

  it('страница на выходе всегда хотя бы одна', () => {
    expect(planForm([], {}).pages).toHaveLength(1)
  })

  it('условие смотрит на вопрос той же страницы', () => {
    const blocks = paged()
    const dep: Block = { ...blk('dep', 'g4', 'short_text'), visibleIf: leaf('src', 'is', 'yes') }
    blocks.splice(1, 0, dep)
    expect(planForm(blocks, { src: 'yes' }).visible.has('dep')).toBe(true)
  })
})

describe('stripHiddenAnswers', () => {
  const src = choice('src', 'g1', 'single_choice', [{ id: 'yes' }, { id: 'no' }])
  const dep: Block = { ...blk('dep', 'g2', 'short_text'), visibleIf: leaf('src', 'is', 'yes') }
  const list = choice('list', 'g3', 'multi_choice', [
    { id: 'a', visibleIf: leaf('src', 'is', 'yes') },
    { id: 'b' },
  ])
  const single = choice('single', 'g4', 'dropdown', [
    { id: 'x', visibleIf: leaf('src', 'is', 'yes') },
    { id: 'y' },
  ])
  const blocks = [src, dep, list, single]

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

const doc = (blocks: unknown[]): unknown => ({ schemaVersion: 4, blocks })

describe('схема: форма правил', () => {
  const valid: [string, unknown][] = [
    [
      'visibleIf листом',
      doc([
        { id: 'a', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'Да' }] } },
        { id: 'b', groupId: 'g2', type: 'short_text', visibleIf: { blockId: 'a', op: 'is', value: 'o1' } },
      ]),
    ],
    [
      'visibleIf вложенными группами',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'b',
          groupId: 'g2',
          type: 'short_text',
          visibleIf: {
            any: [
              { all: [{ blockId: 'a', op: 'answered' }, { blockId: 'a', op: 'is', value: 'x' }] },
              { blockId: 'a', op: 'is', value: 'y' },
            ],
          },
        },
      ]),
    ],
    [
      'значение не выбрано — законный черновик',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        { id: 'b', groupId: 'g2', type: 'short_text', visibleIf: { blockId: 'a', op: 'is', value: '' } },
      ]),
    ],
    [
      'ссылка вперёд — инертна, но валидна',
      doc([
        { id: 'b', groupId: 'g2', type: 'short_text', visibleIf: { blockId: 'a', op: 'answered' } },
        { id: 'a', groupId: 'g1', type: 'short_text' },
      ]),
    ],
    [
      'ссылка на удалённый блок — инертна, но валидна',
      doc([{ id: 'b', groupId: 'g2', type: 'short_text', visibleIf: { blockId: 'призрак', op: 'answered' } }]),
    ],
    [
      'requiredIf у отвечаемого',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        { id: 'b', groupId: 'g2', type: 'phone', requiredIf: { blockId: 'a', op: 'answered' } },
      ]),
    ],
    [
      'visibleIf у варианта',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'b',
          groupId: 'g2',
          type: 'multi_choice',
          settings: {
            options: [{ id: 'o1', label: 'Поводок', visibleIf: { blockId: 'a', op: 'is', value: 'dog' } }],
          },
        },
      ]),
    ],
    [
      'переходы у разрыва',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'br',
          groupId: 'g2',
          type: 'page_break',
          jumpIf: [
            { when: { blockId: 'a', op: 'empty' }, to: 'br2' },
            { when: { blockId: 'a', op: 'answered' }, end: true },
          ],
        },
        { id: 'c', groupId: 'g3', type: 'short_text' },
      ]),
    ],
    [
      'глубина ровно в лимит',
      doc([
        { id: 'a', groupId: 'g1', type: 'short_text' },
        {
          id: 'b',
          groupId: 'g2',
          type: 'short_text',
          visibleIf: { all: [{ any: [{ all: [{ blockId: 'a', op: 'answered' }] }] }] },
        },
      ]),
    ],
  ]

  it.each(valid)('валиден: %s', (_name, document) => {
    expect(formSchemaSchema.safeParse(document).success).toBe(true)
  })

  const deep = { all: [{ all: [{ all: [{ all: [{ blockId: 'a', op: 'answered' }] }] }] }] }
  const invalid: [string, unknown][] = [
    ['пустое условие', doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: {} }])],
    ['пустая группа', doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: { all: [] } }])],
    [
      'all и any одновременно',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          visibleIf: { all: [{ blockId: 'a', op: 'answered' }], any: [{ blockId: 'a', op: 'empty' }] },
        },
      ]),
    ],
    [
      'группа с полями листа',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          visibleIf: { all: [{ blockId: 'a', op: 'answered' }], blockId: 'a', op: 'is', value: 'x' },
        },
      ]),
    ],
    [
      'неизвестный оператор',
      doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: { blockId: 'a', op: 'matches', value: 'x' } }]),
    ],
    ['оператора нет вовсе', doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: { blockId: 'a' } }])],
    [
      'пустой blockId',
      doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: { blockId: '', op: 'answered' } }]),
    ],
    [
      'значение у answered',
      doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: { blockId: 'a', op: 'answered', value: 'x' } }]),
    ],
    [
      'значение длиннее лимита',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          visibleIf: { blockId: 'a', op: 'is', value: 'я'.repeat(201) },
        },
      ]),
    ],
    ['вложенность глубже лимита', doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: deep }])],
    [
      'лишний ключ в условии',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          visibleIf: { blockId: 'a', op: 'is', value: 'x', not: true },
        },
      ]),
    ],
    [
      'requiredIf у неотвечаемого',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'heading',
          text: [{ t: 'Раздел' }],
          requiredIf: { blockId: 'a', op: 'answered' },
        },
      ]),
    ],
    [
      'required и requiredIf вместе',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          required: true,
          requiredIf: { blockId: 'a', op: 'answered' },
        },
      ]),
    ],
    [
      'visibleIf у разрыва страницы',
      doc([{ id: 'br', groupId: 'g1', type: 'page_break', visibleIf: { blockId: 'a', op: 'answered' } }]),
    ],
    [
      'переходы не у разрыва',
      doc([
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          jumpIf: [{ when: { blockId: 'a', op: 'answered' }, end: true }],
        },
      ]),
    ],
    ['переход без условия', doc([{ id: 'br', groupId: 'g1', type: 'page_break', jumpIf: [{ end: true }] }])],
    [
      'переход без цели',
      doc([{ id: 'br', groupId: 'g1', type: 'page_break', jumpIf: [{ when: { blockId: 'a', op: 'answered' } }] }]),
    ],
    [
      'переход с двумя целями',
      doc([
        {
          id: 'br',
          groupId: 'g1',
          type: 'page_break',
          jumpIf: [{ when: { blockId: 'a', op: 'answered' }, to: 'br2', end: true }],
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
      doc([{ id: 'b', groupId: 'g1', type: 'short_text', visibleIf: { all: leaves.slice(0, n) } }])
    expect(formSchemaSchema.safeParse(rule(MAX_LOGIC_NODES - 1)).success).toBe(true)
    expect(formSchemaSchema.safeParse(rule(MAX_LOGIC_NODES)).success).toBe(false)
  })
})
