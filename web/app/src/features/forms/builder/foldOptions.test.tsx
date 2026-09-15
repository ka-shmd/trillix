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
import { foldPlan, useFoldStore } from './collapsedOptions'

// Сворачивание вопроса на полотне (collapsedOptions.ts): шеврон у подписи, остаётся одна
// подпись, счётчик спрятанных блоков, память в localStorage, разворот по явному запросу
// каретки.

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
  const groupOf = (b: Block) => blocks.filter((x) => x.groupId === b.groupId)
  const hasCaption = (b: Block) => groupOf(b).some((x) => isCaptionType(x.type))
  // Как в GroupRow: первая подпись представляет поле своего вопроса, голое поле — себя.
  const requiredFor = (b: Block, i: number) =>
    isCaptionType(b.type) && (i === 0 || blocks[i - 1]!.groupId !== b.groupId)
      ? blocks.find((x) => x.groupId === b.groupId && isAnswerableType(x.type))
      : isAnswerableType(b.type) && !hasCaption(b)
        ? b
        : undefined
  function Harness() {
    const activeRow = useActiveRowState()
    const ids = useFoldStore((s) => s.ids)
    return (
      <BuilderStoreContext.Provider value={store}>
        <FocusEngineProvider value={engine}>
          <ActiveRowApiProvider value={activeRow.api}>
            <ActiveRowValueProvider value={activeRow.active}>
              <DndContext>
                <SortableContext items={blocks.map((b) => b.id)}>
                  {blocks.map((b, i) => {
                    // Как в GroupRow: свёртку считает группа, строка знает только себя.
                    const group = groupOf(b)
                    const head = group[0]!.id === b.id
                    const fold = foldPlan(group, ids)
                    return (
                      <BlockRow
                        key={b.id}
                        block={b}
                        formId="f"
                        firstInGroup={head}
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
                        foldCount={head ? fold?.count : undefined}
                        folded={head && fold?.folded === true}
                        foldedBy={!head && fold?.folded ? fold.fieldId : undefined}
                      />
                    )
                  })}
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

// Вопрос с пояснением между подписью и списком.
const WITH_NOTE: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Город') },
    { id: 'note', groupId: 'g1', type: 'text', text: textFromString('Где вы живёте') },
    { id: 'ch', groupId: 'g1', type: 'single_choice', settings: OPTIONS },
  ],
}

describe('сворачивание вопроса', () => {
  it('шеврон прячет варианты, подпись называет число блоков, второй клик возвращает', () => {
    setup(QUESTION)
    expect(screen.getByDisplayValue('Казань')).toBeTruthy()

    fireEvent.click(row('cap').getByRole('button', { name: 'Свернуть вопрос' }))
    expect(screen.queryByDisplayValue('Казань')).toBeNull()
    expect(row('cap').getByText('3 блока')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('trillix.foldedOptions')!)).toEqual(['ch'])

    fireEvent.click(row('cap').getByRole('button', { name: 'Развернуть вопрос' }))
    expect(screen.getByDisplayValue('Казань')).toBeTruthy()
    expect(row('cap').queryByText('3 блока')).toBeNull()
    expect(JSON.parse(localStorage.getItem('trillix.foldedOptions')!)).toEqual([])
  })

  it('прочие строки группы прячутся вместе с вариантами и входят в счётчик', () => {
    setup(WITH_NOTE)
    expect(row('note').queryByText('Где вы живёте')).toBeTruthy()

    fireEvent.click(row('cap').getByRole('button', { name: 'Свернуть вопрос' }))
    expect(row('note').queryByText('Где вы живёте')).toBeNull()
    expect(screen.queryByDisplayValue('Казань')).toBeNull()
    expect(row('cap').getByText('4 блока')).toBeTruthy()
    // У спрятанной строки нет и кластера значков: навести на пустое место — не значит
    // получить чужие кнопки.
    expect(row('note').queryAllByRole('button')).toEqual([])
  })

  it('у развёрнутого вопроса кнопка проявляется наведением на вопрос', () => {
    setup(QUESTION)
    const toggle = row('cap').getByRole('button', { name: 'Свернуть вопрос' })
    expect(toggle.className).toContain('opacity-0')
    expect(toggle.className).toContain('group-hover/question:opacity-100')
  })

  it('у свёрнутого кнопка видна всегда, нажимается целиком — и по числу блоков', () => {
    useFoldStore.setState({ ids: new Set(['ch']) })
    setup(QUESTION)
    const toggle = row('cap').getByRole('button', { name: 'Развернуть вопрос' })
    expect(toggle.className).not.toContain('opacity-0 ')
    expect(toggle.className).toContain('hover:bg-muted')
    // Порядок: три точки → число блоков → шеврон; шеврон — по наведению на вопрос.
    const [dots, chevron] = [...toggle.querySelectorAll('svg')]
    expect(dots!.compareDocumentPosition(within(toggle).getByText('3 блока'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(chevron!.getAttribute('class')).toContain('group-hover/question:opacity-100')

    fireEvent.click(within(toggle).getByText('3 блока'))
    expect(screen.getByDisplayValue('Казань')).toBeTruthy()
  })

  it('у голого списка шеврона нет, и запомненная свёртка его не прячет', () => {
    useFoldStore.setState({ ids: new Set(['ch']) })
    setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'ch', groupId: 'g1', type: 'multi_choice', settings: OPTIONS }],
    })
    expect(screen.queryByRole('button', { name: /вопрос/ })).toBeNull()
    expect(screen.getByDisplayValue('Пермь')).toBeTruthy()
  })

  it('явный запрос каретки на список разворачивает вопрос и ставит её на вариант', () => {
    useFoldStore.setState({ ids: new Set(['ch']) })
    const { engine } = setup(QUESTION)
    expect(screen.queryByDisplayValue('Пермь')).toBeNull()

    act(() => engine.focusBlock('ch', 'end'))
    expect(document.activeElement).toBe(screen.getByDisplayValue('Пермь'))
    expect(useFoldStore.getState().ids.has('ch')).toBe(false)
  })

  it('явный запрос каретки на спрятанную строку разворачивает вопрос', () => {
    useFoldStore.setState({ ids: new Set(['ch']) })
    const { engine } = setup(WITH_NOTE)

    act(() => engine.focusBlock('note', 'end'))
    expect(useFoldStore.getState().ids.has('ch')).toBe(false)
    expect(row('note').queryByText('Где вы живёте')).toBeTruthy()
    expect(document.querySelector('[data-block-id="note"]')!.contains(document.activeElement)).toBe(
      true,
    )
  })
})
