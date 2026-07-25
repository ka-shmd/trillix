// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import type { FormSchema } from '@entities/formSchema'
import { isAnswerableType } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { ActiveRowApiProvider, ActiveRowValueProvider, useActiveRowState } from './activeRow'
import { BlockRow } from './BlockRow'
import { BLOCK_COMMON, GLOBAL } from './shortcuts'

// Подсказки полотна (§7): у сфокусированной строки видно ТОЛЬКО специфичные её
// поверхности клавиши, общие вынесены в шпаргалку. Демо-критерий этапа —
// «подсказки перечисляют ровно те клавиши, которые там работают», поэтому проверяем
// не вёрстку, а состав: что обещано на подписи, варианте, объекте и поле.

afterEach(cleanup)

// Полотно теста: настоящие BlockRow под провайдерами активной строки — фокус ставим
// движком, чипы появляются от настоящих focus-событий, как в билдере.
function CanvasBody({
  store,
  engine,
  blocks,
}: {
  store: ReturnType<typeof createBuilderStore>
  engine: ReturnType<typeof createFocusEngine>
  blocks: ReturnType<ReturnType<typeof createBuilderStore>['getState']>['blocks']
}) {
  const activeRow = useActiveRowState()
  const handlers = {
    onAddBelow: vi.fn(),
    onInsertBelow: vi.fn(),
    onBackspaceAtStart: vi.fn(),
    onDeleteObject: vi.fn(),
    onDeleteBlock: vi.fn(),
    onAnswerAction: vi.fn(),
    onArrow: vi.fn(),
  }
  return (
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <ActiveRowApiProvider value={activeRow.api}>
          <ActiveRowValueProvider value={activeRow.active}>
            <DndContext>
              <SortableContext items={blocks.map((b) => b.id)}>
                {blocks.map((b) => (
                  <BlockRow
                    key={b.id}
                    block={b}
                    formId="f"
                    groupHandle={null}
                    // Как в GroupRow: подсказка про Mod+Enter зависит от наличия
                    // отвечаемого блока в группе строки.
                    groupHasAnswer={blocks.some(
                      (x) => x.groupId === b.groupId && isAnswerableType(x.type),
                    )}
                    openMenuOnMount={false}
                    {...handlers}
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

function setup(schema: FormSchema) {
  const engine = createFocusEngine()
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const blocks = store.getState().blocks
  render(<CanvasBody store={store} engine={engine} blocks={blocks} />)
  // Фокус ставим внутри act: чипы появляются от setState в обработчике focus, и без
  // прокачки React проверка увидела бы полотно до перерисовки.
  const focus = (id: string, edge?: 'start' | 'end') =>
    act(() => engine.focusBlock(id, edge))
  return { engine, focus }
}

// chips — подписи клавиш, показанные сейчас у активной строки. Чипы помечены
// aria-hidden (визуальная подсказка), поэтому ищем по DOM, а не ролью.
function chips(): string[] {
  return [...document.querySelectorAll('kbd')].map((k) => k.textContent ?? '')
}

// hints — тексты действий рядом с клавишами.
function hintText(): string {
  return [...document.querySelectorAll('[aria-hidden="true"]')]
    .filter((n) => n.querySelector('kbd'))
    .map((n) => n.textContent ?? '')
    .join(' | ')
}

const QUESTION: FormSchema = {
  schemaVersion: 2,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: 'Как вас зовут?' },
    { id: 'inp', groupId: 'g1', type: 'short_text' },
    { id: 'para', groupId: 'g2', type: 'text', text: 'Просто абзац' },
  ],
}

describe('чипы у сфокусированной строки (§7)', () => {
  it('подпись вопроса: только клавиши текстовой строки, общих нет', () => {
    const { focus } = setup(QUESTION)
    focus('cap', 'end')
    expect(chips()).toEqual(['Enter', '/', 'Ctrl+Enter'])
    // Общий ярус (меню действий, удаление, ↑↓) у строки не показывается — он в
    // шпаргалке. Иначе одинаковый хвост висит у каждой строки.
    for (const s of [...BLOCK_COMMON, ...GLOBAL]) {
      expect(chips(), s.label).not.toContain(s.label.replace('Mod', 'Ctrl'))
    }
  })

  it('одиночный абзац: Mod+Enter не обещаем — прыгать не к чему', () => {
    const { focus } = setup(QUESTION)
    focus('para', 'end')
    expect(chips()).not.toContain('Ctrl+Enter')
    expect(chips()).toContain('Enter')
  })

  it('чипы принадлежат активной строке: одна строка — один набор', () => {
    const { focus } = setup(QUESTION)
    focus('cap', 'end')
    const first = chips()
    focus('para', 'end')
    // Чипы уехали к абзацу целиком, а не размножились по строкам.
    expect(chips().length).toBeLessThanOrEqual(3)
    expect(chips()).not.toEqual(first)
  })

  it('инпут плейсхолдера: своя одна подсказка, а не текстовые клавиши', () => {
    const { focus } = setup(QUESTION)
    focus('inp', 'end')
    expect(chips()).toEqual(['⌫ в пустом'])
    expect(hintText()).toContain('К подписи')
  })

  it('вариант choice: клавиши списка, а не блока', () => {
    const { focus } = setup({
      schemaVersion: 2,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да' }] },
        },
      ],
    })
    focus('ch', 'end')
    expect(chips()).toEqual(['Enter', '⌫ в пустом', 'Alt+↑↓'])
    expect(hintText()).toContain('Новый вариант')
  })

  it('картинке обещан файловый диалог, шкале — нет (разные контексты)', () => {
    const { focus } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'img', groupId: 'g1', type: 'image' },
        { id: 'sc', groupId: 'g2', type: 'scale' },
      ],
    })
    focus('img')
    expect(chips()).toContain('Ctrl+Enter')
    expect(hintText()).toContain('Выбрать файл')
    // На date/scale Cmd+Enter ищет input[type=file] и не находит — клавиши там нет,
    // значит и подсказки быть не должно.
    focus('sc')
    expect(chips()).not.toContain('Ctrl+Enter')
  })

  it('каретка ушла с полотна — чипы гаснут', () => {
    const { focus } = setup(QUESTION)
    focus('cap', 'end')
    expect(chips().length).toBeGreaterThan(0)
    act(() => (document.activeElement as HTMLElement).blur())
    expect(chips()).toEqual([])
    expect(screen.queryByText('Новый блок')).toBeNull()
  })
})
