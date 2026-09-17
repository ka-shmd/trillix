// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import {
  SCHEMA_VERSION,
  isAnswerableType,
  textFromString,
  type Block,
  type FormSchema,
} from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext, useBuilderStore } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'
import { derivedQuestionName } from './questionName'

// Этап 16.4: имя вопроса. Проверяются обе половины решения 3 (ADR §10) — вывод имени
// (что уйдёт в данные, пока автор ничего не ввёл) и поле попапа, которое этот вывод
// показывает плейсхолдером, а введённое кладёт СУБЪЕКТУ настроек.

afterEach(cleanup)

const QUESTION: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
    { id: 'inp', groupId: 'g1', type: 'short_text', settings: {} },
  ],
}

const handlers = {
  onAddBelow: vi.fn(),
  onInsertBelow: vi.fn(),
  onBackspaceAtStart: vi.fn(),
  onBackspaceDelete: vi.fn(),
  onDeleteBlock: vi.fn(),
  onAnswerAction: vi.fn(),
  onArrow: vi.fn(),
  onRowShift: vi.fn(),
}

// Полотно ПОДПИСАНО НА СТОР, и обвязка обязана быть такой же: со снимком блоков,
// снятым один раз, поле имени остаётся контролируемым от stale-значения, React глотает
// возврат к пустой строке (значение пропа не менялось) — и «стёртое имя» проверялось бы
// не на том, что делает редактор. Найдено этим же тестом.
function Canvas() {
  const blocks = useBuilderStore((s) => s.blocks)
  // Как в GroupRow: подпись собранного вопроса представляет его поле — на ней стоит
  // requiredFor, он же субъект настроек (§4.2 спеки).
  const field = blocks.find((b) => isAnswerableType(b.type))
  return (
    <DndContext>
      <SortableContext items={blocks.map((b) => b.id)}>
        {blocks.map((b) => (
          <BlockRow
            key={b.id}
            block={b}
            formId="f"
            groupHandle={null}
            requiredFor={b.id === 'cap' ? field : undefined}
            openMenuOnMount={false}
            {...handlers}
          />
        ))}
      </SortableContext>
    </DndContext>
  )
}

function setup(schema: FormSchema = QUESTION) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  render(
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <Canvas />
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store }
}

const row = (id: string) => within(document.querySelector(`[data-block-id="${id}"]`) as HTMLElement)

function openMenu(id: string) {
  const grip = row(id).getByLabelText('Настройки блока')
  fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 })
  fireEvent.click(grip, { clientX: 10, clientY: 10 })
}

const nameField = () => screen.getByLabelText('Имя') as HTMLInputElement

describe('поле имени в попапе настроек', () => {
  // Ключевое в решении 3: автор видит вывод, а не догадывается о нём. Плейсхолдер —
  // буквально та строка, которая уйдёт в колонку CSV, пока поле пусто.
  it('пустое поле показывает выведенное имя плейсхолдером', () => {
    setup()

    openMenu('inp')

    expect(nameField().value).toBe('')
    expect(nameField().placeholder).toBe('Как вас зовут?')
  })

  it('введённое имя уходит в стор — на ПОЛЕ вопроса, а не на подпись', () => {
    const { store } = setup()

    // Открыт с подписи: субъект настроек — поле её вопроса.
    openMenu('cap')
    fireEvent.change(nameField(), { target: { value: 'fio' } })

    const byId = (id: string) => store.getState().blocks.find((b) => b.id === id) as Block
    expect(byId('inp').name).toBe('fio')
    expect(byId('cap').name).toBeUndefined()
  })

  // Стёртое до конца имя обязано вернуть документ ровно в то состояние, в котором он
  // был до ввода: канон не хранит «имя = ничего».
  it('стёртое имя убирает ключ, а не кладёт пустую строку', () => {
    const { store } = setup()

    openMenu('inp')
    fireEvent.change(nameField(), { target: { value: 'fio' } })
    fireEvent.change(nameField(), { target: { value: '' } })

    const field = store.getState().blocks.find((b) => b.id === 'inp') as Block
    expect(field.name).toBeUndefined()
    expect('name' in JSON.parse(JSON.stringify(field))).toBe(false)
  })

  // У подписи, контента и заголовка формы колонки в выгрузке не бывает — называть
  // нечего, и схема имя у них запрещает.
  it('у неотвечаемой строки поля имени нет', () => {
    setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'para', groupId: 'g1', type: 'text', text: textFromString('Абзац') }],
    })

    openMenu('para')

    expect(screen.queryByLabelText('Имя')).toBeNull()
  })
})

describe('derivedQuestionName — вывод имени (зеркало domain.questionLabel)', () => {
  const blk = (b: Partial<Block> & Pick<Block, 'id' | 'type'>): Block => ({
    groupId: 'g_' + b.id,
    ...b,
  })

  it('подпись группы', () => {
    const blocks = [
      blk({ id: 't', groupId: 'g1', type: 'title', text: textFromString('Ваш город') }),
      blk({ id: 'b', groupId: 'g1', type: 'short_text' }),
    ]
    expect(derivedQuestionName(blocks, blocks[1]!)).toBe('Ваш город')
  })

  it('плейсхолдер, когда подписи нет', () => {
    const blocks = [blk({ id: 'b', type: 'email', settings: { placeholder: 'you@ex.com' } })]
    expect(derivedQuestionName(blocks, blocks[0]!)).toBe('you@ex.com')
  })

  // Последняя ступень: «Тип N», где N — позиция среди ОТВЕЧАЕМЫХ блоков. Неотвечаемые
  // в нумерации не участвуют — так же, как в QuestionOrder.
  it('«Тип N» по позиции среди отвечаемых', () => {
    const blocks = [
      blk({ id: 'h', type: 'heading', text: textFromString('Раздел') }),
      blk({ id: 'a', type: 'short_text' }),
      blk({ id: 'b', type: 'scale' }),
    ]
    expect(derivedQuestionName(blocks, blocks[1]!)).toBe('Короткий ответ 1')
    expect(derivedQuestionName(blocks, blocks[2]!)).toBe('Шкала 2')
  })
})
