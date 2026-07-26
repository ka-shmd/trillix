// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import type { Block, FormSchema } from '@entities/formSchema'
import { isAnswerableType, isCaptionType } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'

// Кто чем управляет на полотне (§4 EDITOR, решение владельца 2026-07-26): кластер
// значков «удалить / добавить / перетащить» принадлежит строке, которой можно
// управлять ОТДЕЛЬНО. Строка ответа в озаглавленной группе такой не является —
// вопросом управляет подпись, и значков у поля нет вовсе, как нет и своего Alt+↑↓.
// Голое поле (группа без подписи) значки сохраняет: управлять им больше некому.

afterEach(cleanup)

// Полотно теста: настоящие BlockRow с тем же признаком ownedByCaption, который им
// считает GroupRow, — иначе тест проверял бы не то правило, что живёт в билдере.
function setup(schema: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  const blocks = store.getState().blocks
  const owned = (b: Block) =>
    isAnswerableType(b.type) && blocks.some((x) => x.groupId === b.groupId && isCaptionType(x.type))
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
  render(
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <DndContext>
          <SortableContext items={blocks.map((b) => b.id)}>
            {blocks.map((b) => (
              <BlockRow
                key={b.id}
                block={b}
                formId="f"
                groupHandle={null}
                ownedByCaption={owned(b)}
                openMenuOnMount={false}
                {...handlers}
              />
            ))}
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store, engine, handlers }
}

// row — корень строки блока (у него data-block-id, см. BlockRow).
const row = (id: string) =>
  within(document.querySelector(`[data-block-id="${id}"]`) as HTMLElement)

// controls — подписи кнопок кластера, найденные в строке. Кластер спрятан прозрачностью
// (а не размонтирован), поэтому «нет значков» — это именно отсутствие кнопок в DOM.
const controls = (id: string) =>
  row(id)
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label'))
    .filter((l): l is string => l !== null)

const QUESTION: FormSchema = {
  schemaVersion: 2,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: 'Как вас зовут?' },
    { id: 'inp', groupId: 'g1', type: 'short_text' },
    { id: 'bare', groupId: 'g2', type: 'email' },
    { id: 'para', groupId: 'g3', type: 'text', text: 'Абзац' },
  ],
}

describe('кластер значков строки', () => {
  it('у строки ответа в вопросе значков нет — вопросом управляет подпись', () => {
    setup(QUESTION)
    expect(controls('inp')).not.toContain('Удалить блок')
    expect(controls('inp')).not.toContain('Добавить блок ниже (выбрать тип)')
    expect(controls('inp')).not.toContain('Перетащить блок')
  })

  it('у подписи вопроса значки на месте — это ручка всего вопроса', () => {
    setup(QUESTION)
    expect(controls('cap')).toContain('Удалить вопрос (группу)')
    expect(controls('cap')).toContain('Перетащить блок')
  })

  it('у голого поля значки остаются — управлять им больше некому', () => {
    setup(QUESTION)
    expect(controls('bare')).toContain('Удалить блок')
    expect(controls('bare')).toContain('Перетащить блок')
  })

  it('у одиночного абзаца значки остаются', () => {
    setup(QUESTION)
    expect(controls('para')).toContain('Удалить блок')
  })
})

describe('Alt+↑↓ на строке ответа', () => {
  it('шкала внутри вопроса не двигается и не отдаёт жест обходу', () => {
    const { store, engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: 'Оценка' },
        { id: 'sc', groupId: 'g1', type: 'scale', settings: { scaleMin: 1, scaleMax: 5 } },
      ],
    })
    const before = store.getState().blocks.map((b) => b.id)

    engine.focusBlock('sc')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    expect(store.getState().blocks.map((b) => b.id)).toEqual(before)
    // Гашение важно не меньше самого no-op: непогашенный Alt+↑ провалился бы в
    // обычный обход, и вместо «ничего не произошло» каретка уехала бы на подпись.
    expect(handlers.onArrow).not.toHaveBeenCalled()
  })

  it('голое поле (дата без подписи) двигается как обычный блок', () => {
    const { store, engine } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'para', groupId: 'g1', type: 'text', text: 'Абзац' },
        { id: 'dt', groupId: 'g2', type: 'date', settings: {} },
      ],
    })

    engine.focusBlock('dt')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['dt', 'para'])
  })
})
