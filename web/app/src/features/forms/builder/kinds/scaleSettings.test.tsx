// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { SCHEMA_VERSION, textFromString, type FormSchema } from '@entities/formSchema'
import { createBuilderStore } from '../store'
import { BuilderStoreContext } from '../storeContext'
import { createFocusEngine, FocusEngineProvider } from '../focusEngine'
import { BlockRow } from '../BlockRow'
import { nextScaleRange } from './scaleSettings'

// Этап 16.3: диапазон шкалы ушёл с полотна в попап настроек. Полотно обязано показывать
// только то, что увидит респондент (§1 спеки), а выбор «от/до» — контрол редактора.
// Проверяем обе стороны переезда: на полотне контрола нет, в попапе есть.

afterEach(cleanup)

const SCALE: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Насколько удобно?') },
    { id: 'sc', groupId: 'g1', type: 'scale', settings: { scaleMin: 1, scaleMax: 5 } },
  ],
}

function setup(schema: FormSchema = SCALE) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  const blocks = store.getState().blocks
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
            {blocks.map((b, i) => (
              <BlockRow
                key={b.id}
                block={b}
                formId="f"
                groupHandle={null}
                // Как в GroupRow: подпись вопроса представляет его поле — она же
                // субъект настроек, и типовой раздел попапа берётся у ПОЛЯ.
                requiredFor={i === 0 ? blocks[1] : undefined}
                openMenuOnMount={false}
                {...handlers}
              />
            ))}
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store }
}

const row = (id: string) => within(document.querySelector(`[data-block-id="${id}"]`) as HTMLElement)

function openMenu(id: string, label: string) {
  const grip = row(id).getByLabelText(label)
  fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 })
  fireEvent.click(grip, { clientX: 10, clientY: 10 })
}

describe('диапазон шкалы переехал с полотна в попап', () => {
  it('на полотне у шкалы не осталось контролов выбора', () => {
    setup()
    // Ни нативного select, ни shadcn-триггера (тот — combobox): на строке только
    // превью делений, как у респондента.
    expect(row('sc').queryAllByRole('combobox')).toHaveLength(0)
    expect(document.querySelector('[data-block-id="sc"] select')).toBeNull()
  })

  it('попап шкалы показывает типовой раздел', () => {
    setup()

    openMenu('sc', 'Настройки блока')

    expect(screen.getByLabelText('Начало шкалы')).toBeTruthy()
    expect(screen.getByLabelText('Конец шкалы')).toBeTruthy()
  })

  // Раздел объявляет сам тип, и субъект настроек у подписи — ПОЛЕ вопроса (§4.2):
  // открытый с заголовка попап обязан показать настройки шкалы, а не пустоту.
  it('попап подписи показывает раздел ПОЛЯ её вопроса', () => {
    setup()

    openMenu('cap', 'Настройки блока')

    expect(screen.getByLabelText('Конец шкалы')).toBeTruthy()
  })

  // Раздела нет — нет и разделителя: у большинства типов правится только то, что видно
  // на полотне, и попап у них состоит из одних общих пунктов (§4.3 спеки).
  it('у типа без своего раздела попап показывает одни общие пункты', () => {
    setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'para', groupId: 'g1', type: 'text', text: textFromString('Абзац') }],
    })

    openMenu('para', 'Настройки блока')

    const popup = document.querySelector('[data-slot="popover-content"]') as HTMLElement
    expect(within(popup).getByText('Дублировать')).toBeTruthy()
    expect(within(popup).queryAllByRole('combobox')).toHaveLength(0)
  })
})

describe('nextScaleRange — связь пары', () => {
  it('максимум держится хотя бы на шаг выше минимума', () => {
    expect(nextScaleRange({ min: 0, max: 5 }, { min: 1 })).toEqual({ min: 1, max: 5 })
    // Минимум догнал максимум — максимум уступает шаг, а не даёт невалидный документ.
    expect(nextScaleRange({ min: 0, max: 1 }, { min: 1 })).toEqual({ min: 1, max: 2 })
    expect(nextScaleRange({ min: 1, max: 5 }, { max: 1 })).toEqual({ min: 1, max: 2 })
  })

  it('незаданная сторона остаётся прежней', () => {
    expect(nextScaleRange({ min: 1, max: 7 }, {})).toEqual({ min: 1, max: 7 })
    expect(nextScaleRange({ min: 1, max: 7 }, { max: 10 })).toEqual({ min: 1, max: 10 })
  })
})
