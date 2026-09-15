// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type Block, type FormSchema, textFromString, SCHEMA_VERSION } from '@entities/formSchema'
import { isAnswerableType, isCaptionType } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { ActiveRowApiProvider, ActiveRowValueProvider, useActiveRowState } from './activeRow'
import { BlockRow } from './BlockRow'
import { useFoldStore } from './collapsedOptions'

// Сворачивание вариантов на полотне (collapsedOptions.ts): шеврон у подписи вопроса,
// счётчик спрятанного, память в localStorage, разворот по явному запросу каретки.

afterEach(() => {
  cleanup()
  useFoldStore.setState({ ids: new Set() })
  localStorage.clear()
})

function setup(schema: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  const blocks = store.getState().blocks
  const hasCaption = (b: Block) =>
    blocks.some((x) => x.groupId === b.groupId && isCaptionType(x.type))
  // Как в GroupRow: первая подпись представляет поле своего вопроса, голое поле — себя.
  const requiredFor = (b: Block, i: number) =>
    isCaptionType(b.type) && (i === 0 || blocks[i - 1]!.groupId !== b.groupId)
      ? blocks.find((x) => x.groupId === b.groupId && isAnswerableType(x.type))
      : isAnswerableType(b.type) && !hasCaption(b)
        ? b
        : undefined
  function Harness() {
    const activeRow = useActiveRowState()
    return (
      <BuilderStoreContext.Provider value={store}>
        <FocusEngineProvider value={engine}>
          <ActiveRowApiProvider value={activeRow.api}>
            <ActiveRowValueProvider value={activeRow.active}>
              <DndContext>
                <SortableContext items={blocks.map((b) => b.id)}>
                  {blocks.map((b, i) => (
                    <BlockRow
                      key={b.id}
                      block={b}
                      formId="f"
                      groupHandle={null}
                      requiredFor={requiredFor(b, i)}
                      needsCaption={false}
                      openMenuOnMount={false}
                      onAddBelow={vi.fn()}
                      onInsertBelow={vi.fn()}
                      onBackspaceAtStart={vi.fn()}
                      onBackspaceDelete={vi.fn()}
                      onDeleteBlock={vi.fn()}
                      onAnswerAction={vi.fn()}
                      onArrow={vi.fn()}
                      onRowShift={vi.fn()}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </ActiveRowValueProvider>
          </ActiveRowApiProvider>
        </FocusEngineProvider>
      </BuilderStoreContext.Provider>
    )
  }
  render(<Harness />)
  return { engine }
}

const row = (id: string) => within(document.querySelector(`[data-block-id="${id}"]`) as HTMLElement)

const OPTIONS = {
  options: [
    { id: 'o1', label: 'Москва' },
    { id: 'o2', label: 'Казань' },
    { id: 'o3', label: 'Пермь' },
  ],
}

const QUESTION: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Город') },
    { id: 'ch', groupId: 'g1', type: 'single_choice', settings: OPTIONS },
  ],
}

describe('сворачивание вариантов', () => {
  it('шеврон прячет варианты, подпись называет их число, второй клик возвращает', () => {
    setup(QUESTION)
    expect(screen.getByDisplayValue('Казань')).toBeTruthy()

    fireEvent.click(row('cap').getByRole('button', { name: 'Свернуть варианты' }))
    expect(screen.queryByDisplayValue('Казань')).toBeNull()
    expect(row('cap').getByText('3 варианта')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('trillix.foldedOptions')!)).toEqual(['ch'])

    fireEvent.click(row('cap').getByRole('button', { name: 'Развернуть варианты' }))
    expect(screen.getByDisplayValue('Казань')).toBeTruthy()
    expect(row('cap').queryByText('3 варианта')).toBeNull()
    expect(JSON.parse(localStorage.getItem('trillix.foldedOptions')!)).toEqual([])
  })

  it('шеврон проявляется наведением на вопрос', () => {
    setup(QUESTION)
    const chevron = row('cap').getByRole('button', { name: 'Свернуть варианты' })
    expect(chevron.className).toContain('opacity-0')
    expect(chevron.className).toContain('group-hover/question:opacity-100')
  })

  it('у голого списка шеврона нет, и запомненная свёртка его не прячет', () => {
    useFoldStore.setState({ ids: new Set(['ch']) })
    setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'ch', groupId: 'g1', type: 'multi_choice', settings: OPTIONS }],
    })
    expect(screen.queryByRole('button', { name: /варианты/ })).toBeNull()
    expect(screen.getByDisplayValue('Пермь')).toBeTruthy()
  })

  it('явный запрос каретки разворачивает список и ставит её на вариант', () => {
    useFoldStore.setState({ ids: new Set(['ch']) })
    const { engine } = setup(QUESTION)
    expect(screen.queryByDisplayValue('Пермь')).toBeNull()

    act(() => engine.focusBlock('ch', 'end'))
    expect(document.activeElement).toBe(screen.getByDisplayValue('Пермь'))
    expect(useFoldStore.getState().ids.has('ch')).toBe(false)
  })
})
