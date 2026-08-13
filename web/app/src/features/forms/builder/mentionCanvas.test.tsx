// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useStore } from 'zustand'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type Block, type FormSchema, SCHEMA_VERSION, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'
import { richCaret, setCaret } from './richCaret'

// Подстановка ответа на ПОЛОТНЕ (docs/design/mentions.md §7): «@» открывает меню
// вопросов выше, выбор ставит неделимый чип, переименование источника чип
// переподписывает.
//
// Чего этот файл не доказывает и что обязан посмотреть человек в браузере: как чип
// выглядит, действительно ли Backspace сносит его целиком (это поведение БРАУЗЕРА на
// contenteditable=false, happy-dom его не воспроизводит) и не мешает ли меню каретке.

afterEach(cleanup)

const line = () => document.querySelector('[data-rich-line]') as HTMLElement
const menuText = () => document.querySelector('[role="listbox"]')?.textContent ?? null

// Документ: вопрос «Имя» (подпись + поле) и ниже пустая подпись второго вопроса —
// строка, в которой мы и набираем «@».
const doc = (): Block[] => [
  { id: 'cap1', groupId: 'g1', type: 'title', text: textFromString('Имя') },
  { id: 'q1', groupId: 'g1', type: 'short_text' },
  { id: 'cap2', groupId: 'g2', type: 'title', text: [] },
  { id: 'q2', groupId: 'g2', type: 'phone' },
]

function canvas(blocks: Block[] = doc(), rowId = 'cap2') {
  const store = createBuilderStore()
  const schema: FormSchema = { schemaVersion: SCHEMA_VERSION, blocks }
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  function Row() {
    const all = useStore(store, (s) => s.blocks)
    const b = all.find((x) => x.id === rowId)
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
      <FocusEngineProvider value={engine}>
        <DndContext>
          <SortableContext items={blocks.map((b) => b.id)}>
            <Row />
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store, engine }
}

function lastTextNode(el: HTMLElement): Text | null {
  let out: Text | null = null
  const walk = (n: Node) => {
    if (n.nodeType === 3) out = n as Text
    else n.childNodes.forEach(walk)
  }
  walk(el)
  return out
}

// Посимвольный набор — как в richLine.test.tsx: триггер «@» срабатывает только когда
// символ стоит прямо перед кареткой, поэтому набор обязан идти по одному символу.
function typeRich(value: string) {
  const el = line()
  let cur = el.textContent ?? ''
  for (const ch of value.slice(cur.length)) {
    const last = lastTextNode(el)
    if (last) last.textContent += ch
    else el.appendChild(el.ownerDocument.createTextNode(ch))
    cur += ch
    setCaret(el, cur.length)
    fireEvent.input(el)
  }
}

const textOf = (store: ReturnType<typeof canvas>['store'], id: string) =>
  store.getState().blocks.find((b) => b.id === id)?.text ?? []

describe('«@» на полотне', () => {
  it('открывает меню с вопросами ВЫШЕ строки', () => {
    const { store } = canvas()
    line().focus()
    typeRich('@')
    expect(menuText()).toContain('Имя')
    // «@» остаётся литералом в тексте, как «/» у слеш-меню: меню — надстройка над
    // набором, а не режим ввода.
    expect(textOf(store, 'cap2')).toEqual([{ t: '@' }])
  })

  it('Enter ставит чип: имя вопроса в тексте, id источника в ref', () => {
    const { store } = canvas()
    line().focus()
    typeRich('@')
    act(() => {
      fireEvent.keyDown(line(), { code: 'Enter' })
    })
    // Источник — ОТВЕЧАЕМЫЙ блок вопроса (на него ссылаются ответы), а не его подпись.
    // Следом за чипом — пробел: после вставки автор продолжает писать.
    expect(textOf(store, 'cap2')).toEqual([{ t: 'Имя', ref: 'q1' }, { t: ' ' }])
    expect(menuText()).toBeNull()
  })

  it('чип печатается неделимым узлом с data-ref', () => {
    canvas()
    line().focus()
    typeRich('@')
    act(() => {
      fireEvent.keyDown(line(), { code: 'Enter' })
    })
    const chip = line().querySelector('[data-ref]') as HTMLElement
    expect(chip.dataset.ref).toBe('q1')
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.className).toContain('rf-mention')
  })

  // Каретка внутри contenteditable=false не рисуется вовсе, поэтому смещение «конец
  // имени» после вставки означало бы для автора «печатать некуда» (дефект, найденный
  // владельцем в браузере).
  it('после вставки каретка стоит ЗА чипом, а не внутри него', () => {
    canvas()
    line().focus()
    typeRich('@')
    act(() => {
      fireEvent.keyDown(line(), { code: 'Enter' })
    })
    const chip = line().querySelector('[data-ref]') as HTMLElement
    const sel = document.getSelection()!
    expect(sel.anchorNode).not.toBeNull()
    expect(chip.contains(sel.anchorNode)).toBe(false)
    // За пробелом, который вставка поставила следом за чипом: печатать автор
    // продолжает с нового слова.
    expect(richCaret(line()).text().caret).toBe('Имя '.length)
  })

  // Почта в тексте вопроса — обычное дело, и меню, всплывающее посреди неё, было бы
  // дефектом, а не подсказкой.
  it('«@» в середине слова меню не открывает', () => {
    canvas()
    line().focus()
    typeRich('ivan@')
    expect(menuText()).toBeNull()
  })

  it('фильтр по набранному после «@»; несовпадение оставляет меню с пустым списком', () => {
    canvas()
    line().focus()
    typeRich('@им')
    expect(menuText()).toContain('Имя')
    typeRich('@имххх')
    expect(menuText()).toContain('Нет вопросов выше')
  })

  it('Esc закрывает меню, набранное остаётся текстом', () => {
    const { store } = canvas()
    line().focus()
    typeRich('@им')
    act(() => {
      fireEvent.keyDown(line(), { code: 'Escape' })
    })
    expect(menuText()).toBeNull()
    expect(textOf(store, 'cap2')).toEqual([{ t: '@им' }])
  })

  // Ссылаться можно только назад (§4 спеки), и список это обещание держит: в ПЕРВОЙ
  // строке документа подставлять нечего.
  it('в первой строке документа предлагать нечего', () => {
    const first: Block = { id: 'cap0', groupId: 'g0', type: 'title', text: [] }
    canvas([first, ...doc()], 'cap0')
    line().focus()
    typeRich('@')
    expect(menuText()).toContain('Нет вопросов выше')
  })
})

describe('имя в чипе живёт', () => {
  it('переименование источника переподписывает чип тем же шагом', () => {
    const { store } = canvas()
    line().focus()
    typeRich('@')
    act(() => {
      fireEvent.keyDown(line(), { code: 'Enter' })
    })
    expect(textOf(store, 'cap2')).toEqual([{ t: 'Имя', ref: 'q1' }, { t: ' ' }])
    act(() => {
      store.getState().updateBlock('cap1', { text: textFromString('Как вас зовут') })
    })
    expect(textOf(store, 'cap2')).toEqual([{ t: 'Как вас зовут', ref: 'q1' }, { t: ' ' }])
    // Один шаг истории, а не два: undo возвращает и имя вопроса, и подпись чипа.
    act(() => {
      store.getState().undo()
    })
    expect(textOf(store, 'cap2')).toEqual([{ t: 'Имя', ref: 'q1' }, { t: ' ' }])
  })

  it('документ без чипов уборка не трогает — тот же массив блоков', () => {
    const { store } = canvas()
    const before = store.getState().blocks
    act(() => {
      store.getState().updateBlock('cap1', { text: textFromString('Имя и фамилия') })
    })
    const after = store.getState().blocks
    // Блоки, которых правка не касалась, остаются ТЕМИ ЖЕ объектами: свежие копии на
    // каждое нажатие перерисовывали бы полотно мимо memo (STATUS, перф полотна).
    expect(after.find((b) => b.id === 'cap2')).toBe(before.find((b) => b.id === 'cap2'))
  })
})
