// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { type Block, SCHEMA_VERSION, textFromString } from '@entities/formSchema'

import { PreviewPane } from '../PreviewPane'
import { createBuilderStore } from '../store'
import { BuilderStoreContext } from '../storeContext'
import { planForm } from '@fields/logic'

import {
  asRootGroup,
  defaultLeaf,
  requiredMode,
  requiredPatch,
  ruleCarrier,
  ruleSummary,
  sourcesFor,
} from './model'

// Условная логика в превью (фаза 21, слайс 2). Тест ДОМ-ный, а не модельный, и это не
// перестраховка: модель проверена таблицей в entities/logic.test.ts, а здесь проверяется
// ровно то, чего модель не видит, — что превью действительно перестало рисовать
// скрытый вопрос и что оно вообще заполняемо (без ответов ветку не проверить никак).

afterEach(cleanup)

const choice = (id: string, caption: string): Block[] => [
  { id: `t_${id}`, groupId: `g_${id}`, type: 'title', text: textFromString(caption) },
  {
    id,
    groupId: `g_${id}`,
    type: 'single_choice',
    settings: {
      options: [
        { id: 'yes', label: 'Да' },
        { id: 'no', label: 'Нет' },
      ],
    },
  },
]

const dependent = (id: string, caption: string, rule: Block['visibleIf']): Block[] => [
  { id: `t_${id}`, groupId: `g_${id}`, type: 'title', text: textFromString(caption), visibleIf: rule },
  { id, groupId: `g_${id}`, type: 'short_text' },
]

function renderPreview(blocks: Block[]) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  return render(
    <BuilderStoreContext.Provider value={store}>
      <PreviewPane title="Анкета" />
    </BuilderStoreContext.Provider>,
  )
}

describe('превью показывает вопрос по условию', () => {
  const doc = (): Block[] => [
    ...choice('pet', 'Есть питомец?'),
    ...dependent('kind', 'Какой?', { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] }),
  ]

  it('до ответа зависимый вопрос скрыт', () => {
    renderPreview(doc())
    expect(screen.getByText('Есть питомец?')).toBeTruthy()
    expect(screen.queryByText('Какой?')).toBeNull()
  })

  it('ответ «Да» показывает вопрос, «Нет» — снова прячет', () => {
    renderPreview(doc())
    // Превью заполняемое (фаза 21): без этого ветку не проверить, и автор увидел бы
    // в превью пустоту вместо только что настроенного ветвления.
    // Кликаем сам radio, а не подпись: у карточки варианта настоящий input спрятан за
    // видом (rf-choice-input), и клик по label в happy-dom его не переключает.
    const [yes, no] = screen.getAllByRole('radio')
    fireEvent.click(yes!)
    expect(screen.getByText('Какой?')).toBeTruthy()

    fireEvent.click(no!)
    expect(screen.queryByText('Какой?')).toBeNull()
  })

  it('страница, где всё скрыто, не показывается', () => {
    renderPreview([
      ...choice('pet', 'Есть питомец?'),
      { id: 'brk', groupId: 'g_brk', type: 'page_break' },
      ...dependent('kind', 'Какой?', { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] }),
    ])
    // Второй страницы нет вовсе — значит и кнопки «Далее» нет, форма из одного шага.
    expect(screen.queryByText('Далее')).toBeNull()

    fireEvent.click(screen.getAllByRole('radio')[0]!)
    expect(screen.getByText('Далее')).toBeTruthy()
  })

  it('инертное правило показывает вопрос, а не прячет', () => {
    // Источник стоит НИЖЕ носителя: правило не действует, и вопрос виден — иначе
    // перестановка блоков молча вырезала бы кусок формы.
    renderPreview([
      ...dependent('kind', 'Какой?', { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] }),
      ...choice('pet', 'Есть питомец?'),
    ])
    expect(screen.getByText('Какой?')).toBeTruthy()
  })
})

describe('модель редактора правил', () => {
  const blocks = [
    ...choice('pet', 'Есть питомец?'),
    ...dependent('kind', 'Какой?', { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] }),
  ]

  it('носитель правила — голова группы, а не поле', () => {
    expect(ruleCarrier(blocks, 'kind')?.id).toBe('t_kind')
    expect(ruleCarrier(blocks, 't_kind')?.id).toBe('t_kind')
  })

  it('источники — только отвечаемые вопросы выше носителя', () => {
    expect(sourcesFor(blocks, 't_kind').map((b) => b.id)).toEqual(['pet'])
    // Выше первого вопроса источников нет — диалог об этом и скажет.
    expect(sourcesFor(blocks, 't_pet')).toEqual([])
  })

  it('новое условие берёт осмысленный для типа оператор', () => {
    expect(defaultLeaf(blocks[1]!)).toEqual({ blockId: 'pet', op: 'is' })
  })

  it('правило читается одной строкой именами вопросов и подписями вариантов', () => {
    expect(ruleSummary(blocks, blocks[2]!.visibleIf)).toBe('Есть питомец? равен Да')
    expect(ruleSummary(blocks, undefined)).toBe('всегда')
  })

  it('одинокий лист заворачивается в группу на чтении', () => {
    expect(asRootGroup({ blockId: 'pet', op: 'answered' })).toEqual({
      all: [{ blockId: 'pet', op: 'answered' }],
    })
  })
})

describe('обязательность — три состояния', () => {
  const field: Block = { id: 'q', groupId: 'g', type: 'short_text' }
  const rule = { all: [{ blockId: 'src', op: 'answered' as const }] }

  it('режим читается из документа', () => {
    expect(requiredMode(field)).toBe('no')
    expect(requiredMode({ ...field, required: true })).toBe('always')
    expect(requiredMode({ ...field, requiredIf: rule })).toBe('conditional')
  })

  // Схема запрещает required и requiredIf вместе, поэтому патч всегда чистит второе
  // поле: иначе первое же переключение ловило бы 422 в автосейве.
  it('патч режима всегда чистит второе поле', () => {
    expect(requiredPatch('always')).toEqual({ required: true, requiredIf: undefined })
    expect(requiredPatch('no')).toEqual({ required: false, requiredIf: undefined })
    expect(requiredPatch('conditional', rule)).toEqual({ required: false, requiredIf: rule })
  })

  it('звёздочка обязательности считается по плану, а не по флагу', () => {
    // Условие не сработало — поле необязательно, звёздочки нет; сработало — есть.
    const blocks: Block[] = [
      ...choice('pet', 'Есть питомец?'),
      { ...field, requiredIf: { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] } },
    ]
    expect(planForm(blocks, {}).required.has('q')).toBe(false)
    expect(planForm(blocks, { pet: 'yes' }).required.has('q')).toBe(true)
  })

  it('скрытый вопрос не обязателен, даже когда условие обязательности сработало', () => {
    const blocks: Block[] = [
      ...choice('pet', 'Есть питомец?'),
      {
        ...field,
        visibleIf: { all: [{ blockId: 'pet', op: 'is', value: 'no' }] },
        requiredIf: { all: [{ blockId: 'pet', op: 'answered' }] },
      },
    ]
    const plan = planForm(blocks, { pet: 'yes' })
    expect(plan.visible.has('q')).toBe(false)
    expect(plan.required.has('q')).toBe(false)
  })
})
