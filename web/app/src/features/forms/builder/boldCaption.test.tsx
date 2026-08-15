// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useStore } from 'zustand'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type Block, type FormSchema, SCHEMA_VERSION } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'
import { setCaret } from './richCaret'
import { markClass } from './richText'

// ЖИРНОСТЬ ЗАГОЛОВКОВ ЛЕЖИТ В ДОКУМЕНТЕ (2026-08-15). До этого вес держала поверхность
// (.rf-label/.rf-heading/.rf-title в fields.css), и снять жирность было нечем: марка
// ложилась поверх веса, а не заменяла его. Теперь текст подписи рождается с маркой `b` —
// отсюда два обязательства, каждое проверяется ниже:
//   1. первый символ в ПУСТОЙ подписи получает марку (иначе автор видит обычный текст
//      там, где всегда был жирный);
//   2. абзац её НЕ получает (иначе жирным станет всё подряд).
//
// Чего файл не доказывает: что дальнейший набор продолжает жирный кусок — это поведение
// БРАУЗЕРА на contenteditable (он вкладывает новый символ в соседний <span>), happy-dom
// его не воспроизводит. Смотреть человеку в браузере.

afterEach(cleanup)

const line = () => document.querySelector('[data-rich-line]') as HTMLElement

function canvas(block: Block) {
  const store = createBuilderStore()
  const schema: FormSchema = { schemaVersion: SCHEMA_VERSION, blocks: [block] }
  store.getState().hydrate(schema)
  function Row() {
    const b = useStore(store, (s) => s.blocks).find((x) => x.id === block.id)
    if (!b) return null
    return (
      <BlockRow
        block={b}
        formId="f"
        groupHandle={null}
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
    )
  }
  render(
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={createFocusEngine()}>
        <DndContext>
          <SortableContext items={[block.id]}>
            <Row />
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return store
}

// Набор в пустую строку: браузер кладёт голый текстовый узел — ровно то состояние, из
// которого досев и обязан сделать размеченный кусок.
function type(value: string) {
  const el = line()
  el.appendChild(el.ownerDocument.createTextNode(value))
  setCaret(el, value.length)
  act(() => {
    fireEvent.input(el)
  })
}

const textOf = (store: ReturnType<typeof canvas>, id: string) =>
  store.getState().blocks.find((b) => b.id === id)?.text ?? []

describe('жирность подписи живёт в тексте', () => {
  it('первый символ в пустой подписи вопроса рождается жирным', () => {
    const store = canvas({ id: 'cap', groupId: 'g', type: 'title', text: [] })
    type('Имя')
    expect(textOf(store, 'cap')).toEqual([{ t: 'Имя', m: ['b'] }])
  })

  it('заголовок раздела — так же', () => {
    const store = canvas({ id: 'h', groupId: 'g', type: 'heading', text: [] })
    type('Раздел')
    expect(textOf(store, 'h')).toEqual([{ t: 'Раздел', m: ['b'] }])
  })

  it('абзац остаётся обычным', () => {
    const store = canvas({ id: 'p', groupId: 'g', type: 'text', text: [] })
    type('Пояснение')
    expect(textOf(store, 'p')).toEqual([{ t: 'Пояснение' }])
  })

  // Досев — только для ПУСТОЙ строки. Иначе он отменял бы снятие жирности: автор убрал
  // её у слова, дописал букву — и жирность вернулась бы на весь кусок.
  it('в непустой подписи текст без марки остаётся без марки', () => {
    const store = canvas({ id: 'cap', groupId: 'g', type: 'title', text: [{ t: 'Имя' }] })
    type(' и фамилия')
    expect(textOf(store, 'cap')).toEqual([{ t: 'Имя и фамилия' }])
  })

  // Ресинк поверхности после досева обязателен: модель говорит «жирный», а в DOM лежит
  // голый текстовый узел, и без перепечатки следующий символ родился бы вне куска.
  it('поверхность перепечатывается размеченной', () => {
    canvas({ id: 'cap', groupId: 'g', type: 'title', text: [] })
    type('Имя')
    expect(line().querySelector(`.${markClass('b')}`)?.textContent).toBe('Имя')
  })
})

// ПОДСКАЗКА ВОЗВРАЩАЕТСЯ, КОГДА ТЕКСТ СТЁРЛИ. Её рисует `[data-rich-line]:empty::before`,
// а `:empty` — это «ни одного ребёнка», не «нет текста»: браузер после стирания
// последнего символа оставляет за собой остаток (служебный <br> либо опустевший <span>
// разметки), и подсказка не возвращалась бы, хотя строка пуста.
describe('пустая строка — пустой узел', () => {
  const erase = () => {
    const el = line()
    // Так стирание выглядит в DOM: текста нет, остаток разметки браузер оставил.
    el.replaceChildren(el.ownerDocument.createElement('br'))
    act(() => {
      fireEvent.input(el)
    })
  }

  it('остаток разметки убирается вместе с последним символом', () => {
    const store = canvas({ id: 'cap', groupId: 'g', type: 'title', text: [{ t: 'Имя', m: ['b'] }] })
    erase()
    expect(textOf(store, 'cap')).toEqual([])
    expect(line().childNodes.length).toBe(0)
  })

  it('после стирания строка снова набирается жирной', () => {
    const store = canvas({ id: 'cap', groupId: 'g', type: 'title', text: [{ t: 'Имя', m: ['b'] }] })
    erase()
    type('Фамилия')
    expect(textOf(store, 'cap')).toEqual([{ t: 'Фамилия', m: ['b'] }])
  })
})
