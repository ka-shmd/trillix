// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { type Block, type LogicAction, SCHEMA_VERSION, textFromString } from '@entities/formSchema'

import { PreviewPane } from '../PreviewPane'
import { createBuilderStore } from '../store'
import { BuilderStoreContext } from '../storeContext'

// Условная логика в превью. Тест ДОМ-ный, а не модельный, и это не перестраховка:
// семантика проверена таблицами в entities/logic.test.ts (и их зеркалом в Go), а здесь
// ровно то, чего модель не видит, — что превью действительно перестало рисовать
// скрытый вопрос, что оно заполняемо (без ответов ветку не проверить никак) и что
// кнопки на заблокированной странице нет.

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

const question = (id: string, caption: string): Block[] => [
  { id: `t_${id}`, groupId: `g_${id}`, type: 'title', text: textFromString(caption) },
  { id, groupId: `g_${id}`, type: 'short_text' },
]

// Блок правила: стоит ПЕРЕД целью, читает то, что выше него.
const logicBlock = (id: string, when: unknown, then: LogicAction[]): Block => ({
  id,
  groupId: `g_${id}`,
  type: 'logic',
  logic: { when: when as never, then },
})

const answered = (blockId: string, value: string) => ({ blockId, op: 'is' as const, value })

function renderPreview(blocks: Block[]) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  return render(
    <BuilderStoreContext.Provider value={store}>
      <PreviewPane title="Анкета" badge={false} />
    </BuilderStoreContext.Provider>,
  )
}

// Клик по варианту источника: превью заполняемое, ветка проверяется ответом. Кликаем
// сам radio, а не подпись, — у карточки варианта настоящий input спрятан за видом
// (rf-choice-input), и клик по label в happy-dom его не переключает.
const pick = (i: number) => fireEvent.click(screen.getAllByRole('radio')[i]!)
const YES = 0
const NO = 1

describe('превью показывает вопрос по условию', () => {
  const doc = (): Block[] => [
    ...choice('pet', 'Есть питомец?'),
    logicBlock('L', answered('pet', 'yes'), [{ kind: 'show', targets: ['t_kind'] }]),
    ...question('kind', 'Какой?'),
  ]

  it('до ответа зависимый вопрос скрыт', () => {
    renderPreview(doc())
    expect(screen.queryByText('Какой?')).toBeNull()
  })

  it('ответ «Да» показывает вопрос, «Нет» — снова прячет', () => {
    renderPreview(doc())
    pick(YES)
    expect(screen.getByText('Какой?')).toBeTruthy()
    pick(NO)
    expect(screen.queryByText('Какой?')).toBeNull()
  })

  it('инертное правило показывает вопрос, а не прячет', () => {
    // Источника нет в документе: правило не действует, значит его как бы нет.
    const blocks: Block[] = [
      logicBlock('L', answered('призрак', 'yes'), [{ kind: 'show', targets: ['t_kind'] }]),
      ...question('kind', 'Какой?'),
    ]
    renderPreview(blocks)
    expect(screen.getByText('Какой?')).toBeTruthy()
  })

  it('блок условия респонденту не показывается', () => {
    renderPreview(doc())
    expect(screen.queryByText('Когда')).toBeNull()
    expect(screen.queryByText('Тогда')).toBeNull()
  })

  it('пустой план БЕЗ правил объясняется «добавьте блоки», а не условиями', () => {
    renderPreview([{ id: 'br', groupId: 'g1', type: 'page_break' }])
    expect(screen.getByText(/добавьте блоки/i)).toBeTruthy()
  })

  it('пустой план С правилами объясняется условиями', () => {
    // Источника в документе нет — но правило есть, и текст про условия, а не «добавьте
    // блоки»: пустой план бывает и без логики.
    renderPreview([
      logicBlock('L', answered('pet', 'yes'), [{ kind: 'show', targets: ['t_kind'] }]),
      ...question('kind', 'Какой?'),
      logicBlock('L2', answered('kind', 'x'), [{ kind: 'hide', targets: ['t_kind'] }]),
    ])
    expect(screen.queryByText('Какой?')).toBeTruthy()
  })
})

describe('превью: варианты, страницы и кнопка', () => {
  it('скрытый вариант не рисуется в списке', () => {
    const blocks: Block[] = [
      ...choice('pet', 'Кто у вас?'),
      logicBlock('L', answered('pet', 'yes'), [{ kind: 'show', targets: ['leash'] }]),
      {
        id: 't_stuff',
        groupId: 'g_stuff',
        type: 'title',
        text: textFromString('Что нужно?'),
      },
      {
        id: 'stuff',
        groupId: 'g_stuff',
        type: 'multi_choice',
        settings: {
          options: [
            { id: 'leash', label: 'Поводок' },
            { id: 'food', label: 'Корм' },
          ],
        },
      },
    ]
    renderPreview(blocks)
    expect(screen.queryByText('Поводок')).toBeNull()
    expect(screen.getByText('Корм')).toBeTruthy()
    pick(YES)
    expect(screen.getByText('Поводок')).toBeTruthy()
  })

  it('«Далее» по сработавшему переходу перескакивает страницу', () => {
    const blocks: Block[] = [
      ...choice('pet', 'Есть питомец?'),
      logicBlock('L', answered('pet', 'no'), [{ kind: 'jump', to: 'br2' }]),
      { id: 'br1', groupId: 'gb1', type: 'page_break' },
      ...question('kind', 'Какой?'),
      { id: 'br2', groupId: 'gb2', type: 'page_break' },
      ...question('phone', 'Телефон?'),
    ]
    renderPreview(blocks)
    pick(NO)
    fireEvent.click(screen.getByText('Далее'))
    expect(screen.queryByText('Какой?')).toBeNull()
    expect(screen.getByText('Телефон?')).toBeTruthy()
  })

  it('«скрыть кнопку» убирает кнопку со страницы', () => {
    const blocks: Block[] = [
      ...choice('pet', 'Есть питомец?'),
      logicBlock('L', answered('pet', 'no'), [{ kind: 'block_submit' }]),
    ]
    renderPreview(blocks)
    expect(screen.getByText('Отправить')).toBeTruthy()
    pick(NO)
    // Кнопки НЕТ вовсе, а не disabled: отключённая обещает, что вот-вот станет
    // доступной, — а здесь ветка-тупик.
    expect(screen.queryByText('Отправить')).toBeNull()
  })
})

// Ссылка на источник живёт по id, и смена ТИПА источника условие не рвёт, но может
// сделать оператор бессмысленным — тогда правило инертно, и вопрос снова виден.
describe('находки ревью', () => {
  it('смена типа источника делает правило инертным — вопрос снова виден', () => {
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        ...choice('pet', 'Есть питомец?'),
        logicBlock('L', { blockId: 'pet', op: 'includes', value: 'yes' }, [
          { kind: 'show', targets: ['t_kind'] },
        ]),
        ...question('kind', 'Какой?'),
      ],
    })
    render(
      <BuilderStoreContext.Provider value={store}>
        <PreviewPane title="Анкета" badge={false} />
      </BuilderStoreContext.Provider>,
    )
    // `includes` осмыслен только у множественного выбора: у single_choice правило
    // инертно, и зависимый вопрос показывается.
    expect(screen.getByText('Какой?')).toBeTruthy()
  })
})
