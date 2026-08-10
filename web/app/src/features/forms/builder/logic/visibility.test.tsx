// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { type Block, SCHEMA_VERSION, textFromString } from '@entities/formSchema'

import { PreviewPane } from '../PreviewPane'
import { createBuilderStore } from '../store'
import { BuilderStoreContext } from '../storeContext'
import { planForm, ruleWarnings, stripHiddenAnswers, withVisibleOptions } from '@fields/logic'

import {
  JUMP_END,
  asRootGroup,
  defaultLeaf,
  requiredMode,
  requiredPatch,
  ruleCarrier,
  jumpTargets,
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
      <PreviewPane title="Анкета" canRemoveBadge={false} />
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

describe('скрытие вариантов выбора', () => {
  // Каскад: «Кто у вас?» → в списке принадлежностей вариант «поводок» только для собаки,
  // «лоток» только для кота, «корм» всегда.
  const doc = (): Block[] => [
    ...choice('pet', 'Кто у вас?'),
    {
      id: 'stuff',
      groupId: 'g_stuff',
      type: 'multi_choice',
      settings: {
        options: [
          { id: 'leash', label: 'Поводок', visibleIf: { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] } },
          { id: 'tray', label: 'Лоток', visibleIf: { all: [{ blockId: 'pet', op: 'is', value: 'no' }] } },
          { id: 'food', label: 'Корм' },
        ],
      },
    },
  ]

  it('в списке остаются только варианты со сработавшим условием', () => {
    renderPreview(doc())
    // До ответа не сработало ни одно условие — виден только безусловный вариант.
    expect(screen.queryByText('Поводок')).toBeNull()
    expect(screen.queryByText('Лоток')).toBeNull()
    expect(screen.getByText('Корм')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('radio')[0]!)
    expect(screen.getByText('Поводок')).toBeTruthy()
    expect(screen.queryByText('Лоток')).toBeNull()
  })

  // Блок отдаётся рендеру уже отфильтрованным (withVisibleOptions), поэтому буквенные
  // бейджи считаются по видимому списку и идут подряд — без дырок на месте скрытых.
  it('withVisibleOptions отдаёт исходный объект, когда прятать нечего', () => {
    const blocks = doc()
    const plan = planForm(blocks, { pet: 'yes' })
    const list = blocks[2]!
    expect(withVisibleOptions(list, plan).settings?.options?.map((o) => o.id)).toEqual([
      'leash',
      'food',
    ])
    // У блока без правил — тот же объект, а не копия: копия на каждый рендер заставляла
    // бы React считать поле изменившимся там, где ничего не менялось.
    expect(withVisibleOptions(blocks[1]!, plan)).toBe(blocks[1])
  })

  it('выбранный скрытый вариант не уходит в ответ', () => {
    const blocks = doc()
    // Человек выбрал «лоток» при «Нет», затем переключил на «Да» — вариант скрылся.
    const clean = stripHiddenAnswers(blocks, { pet: 'yes', stuff: ['tray', 'food'] })
    expect(clean.stuff).toEqual(['food'])
  })
})

describe('переходы между страницами', () => {
  // Три страницы: [pet] | [q2] | [q3]; разрывы br1 (открывает 2) и br2 (открывает 3).
  const paged = (jumpIf?: Block['jumpIf']): Block[] => [
    ...choice('pet', 'Есть питомец?'),
    { id: 'br1', groupId: 'g_br1', type: 'page_break', jumpIf },
    ...dependent('q2', 'Уточнение', undefined),
    { id: 'br2', groupId: 'g_br2', type: 'page_break' },
    ...dependent('q3', 'Телефон', undefined),
  ]

  it('цели предлагаются только вперёд, плюс «к отправке»', () => {
    const blocks = paged()
    // С первого разрыва (он открывает страницу 2) вперёд лежит только страница 3.
    expect(jumpTargets(blocks, 'br1')).toEqual([
      { value: 'br2', label: 'Страница 3' },
      { value: JUMP_END, label: 'К отправке' },
    ])
    // Со второго — только отправка: страниц за ним нет.
    expect(jumpTargets(blocks, 'br2')).toEqual([{ value: JUMP_END, label: 'К отправке' }])
  })

  it('«Далее» по сработавшему переходу перескакивает страницу', () => {
    renderPreview(paged([{ when: { all: [{ blockId: 'pet', op: 'is', value: 'no' }] }, to: 'br2' }]))

    // Ответ «Нет» — второе правило пути: страница уточнения выпадает, шагов остаётся два.
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    fireEvent.click(screen.getByText('Далее'))

    expect(screen.getByText('Телефон')).toBeTruthy()
    expect(screen.queryByText('Уточнение')).toBeNull()
  })

  it('без сработавшего перехода идём подряд', () => {
    renderPreview(paged([{ when: { all: [{ blockId: 'pet', op: 'is', value: 'no' }] }, to: 'br2' }]))

    fireEvent.click(screen.getAllByRole('radio')[0]!)
    fireEvent.click(screen.getByText('Далее'))

    expect(screen.getByText('Уточнение')).toBeTruthy()
  })

  it('переход «к отправке» обрывает форму на текущей странице', () => {
    renderPreview(paged([{ when: { all: [{ blockId: 'pet', op: 'is', value: 'no' }] }, end: true }]))

    // До ответа путь обычный — три шага, на первом «Далее».
    expect(screen.getByText('Далее')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('radio')[1]!)
    // Путь стал одностраничным: «Далее» больше нет, на его месте кнопка отправки.
    expect(screen.queryByText('Далее')).toBeNull()
    expect(screen.getByText('Отправить')).toBeTruthy()
  })
})

// Дефект, найденный владельцем в браузере (2026-08-06): диалог переходов отказывал
// «перескакивать некуда» на разрыве, за которым нет ДРУГИХ разрывов. Это была моя
// ошибка в условии: переход «к отправке» осмыслен у любого делящего разрыва, и у
// единственного он как раз главный сценарий — «дальше спрашивать нечего, отправляем».
describe('переходы: когда правило собрать можно', () => {
  const twoPages = (): Block[] => [
    ...choice('pet', 'Есть питомец?'),
    { id: 'br1', groupId: 'g_br1', type: 'page_break' },
    ...dependent('q2', 'Уточнение', undefined),
  ]

  it('у единственного разрыва есть цель «к отправке»', () => {
    expect(jumpTargets(twoPages(), 'br1')).toEqual([{ value: JUMP_END, label: 'К отправке' }])
  })

  it('у последнего из нескольких разрывов тоже', () => {
    const blocks: Block[] = [
      ...twoPages(),
      { id: 'br2', groupId: 'g_br2', type: 'page_break' },
      ...dependent('q3', 'Телефон', undefined),
    ]
    expect(jumpTargets(blocks, 'br2')).toEqual([{ value: JUMP_END, label: 'К отправке' }])
  })

  // Инертный разрыв — единственный случай, когда вести действительно некуда: у
  // респондента он страницу не открывает вовсе, значит и «уйти с неё» невозможно.
  it('у инертного разрыва целей нет', () => {
    const twoInARow: Block[] = [
      ...choice('pet', 'Есть питомец?'),
      { id: 'br1', groupId: 'g_br1', type: 'page_break' },
      { id: 'br2', groupId: 'g_br2', type: 'page_break' },
      ...dependent('q2', 'Уточнение', undefined),
    ]
    expect(jumpTargets(twoInARow, 'br1')).toEqual([])
    // Второй при этом рабочий: он и делит форму.
    expect(jumpTargets(twoInARow, 'br2')).toEqual([{ value: JUMP_END, label: 'К отправке' }])

    const trailing: Block[] = [
      ...choice('pet', 'Есть питомец?'),
      { id: 'br1', groupId: 'g_br1', type: 'page_break' },
    ]
    expect(jumpTargets(trailing, 'br1')).toEqual([])
  })
})

// Находки ревью ветки фазы (2026-08-06). Каждая — про то, что тесты пропустили.
describe('находки ревью', () => {
  it('пустой план БЕЗ правил объясняется «добавьте блоки», а не условиями', () => {
    // Документ из одного разрыва: он инертен, страниц не открывает, план пуст — но
    // условий в форме нет, и «всё скрыто условиями» было бы неправдой.
    renderPreview([{ id: 'brk', groupId: 'g_brk', type: 'page_break' }])
    expect(screen.getByText(/добавьте блоки/i)).toBeTruthy()
    expect(screen.queryByText(/скрыты условиями/i)).toBeNull()
  })

  it('пустой план С правилами объясняется условиями', () => {
    renderPreview([
      ...choice('pet', 'Есть питомец?'),
      { id: 'brk', groupId: 'g_brk', type: 'page_break' },
      ...dependent('kind', 'Какой?', { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] }),
    ])
    // Первая страница видна, значит план не пуст — сообщения нет вовсе.
    expect(screen.queryByText(/скрыты условиями/i)).toBeNull()
    expect(screen.getByText('Есть питомец?')).toBeTruthy()
  })

  // Правило могло стать инертным от смены ТИПА источника: id при этом сохраняется,
  // поэтому подписка на «состав документа» такую правку не замечала.
  it('смена типа источника делает правило инертным — вопрос снова виден', () => {
    const blocks: Block[] = [
      {
        id: 'src',
        groupId: 'g_src',
        type: 'multi_choice',
        settings: { options: [{ id: 'leash', label: 'Поводок' }] },
      },
      {
        id: 'dep',
        groupId: 'g_dep',
        type: 'short_text',
        visibleIf: { all: [{ blockId: 'src', op: 'includes', value: 'leash' }] },
      },
    ]
    expect(planForm(blocks, {}).visible.has('dep')).toBe(false)

    // Тот же id, другой тип: «содержит» к короткому ответу не применим → правило инертно.
    const retyped: Block[] = [{ ...blocks[0]!, type: 'short_text', settings: {} }, blocks[1]!]
    expect(planForm(retyped, {}).visible.has('dep')).toBe(true)
    expect(ruleWarnings(retyped, 'dep', retyped[1]!.visibleIf)[0]?.reason).toContain('не подходит')
  })
})
