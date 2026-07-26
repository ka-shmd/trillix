// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'

// Проба включает свою поверхность только себе: по умолчанию флаг выключен, чтобы
// остальной набор (в т.ч. восемь textarea-зависимых проверок focusContract) оставался
// зелёным. См. комментарий в `flag.ts`.
vi.mock('./flag', () => ({ RICH_TEXT_SPIKE: true }))

import { cleanup, fireEvent, render } from '@testing-library/react'
import { useStore } from 'zustand'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type FormSchema, plainText, textFromString } from '@entities/formSchema'
import { createBuilderStore } from '../store'
import { BuilderStoreContext } from '../storeContext'
import { createFocusEngine, FocusEngineProvider } from '../focusEngine'
import { BlockRow } from '../BlockRow'
import { richCaret, setCaret, setSelection } from './richCaret'
import { spansFromDom } from './spans'

// ПРОБА ЭТАПА 14.0 — поверхность строки. Здесь проверяется главное утверждение пробы:
// подстановка contenteditable вместо <textarea> НЕ переписывает клавиатурный поток
// фазы 13. Восемь сценариев ниже — те самые, что упали в `focusContract.test.tsx`
// после подстановки: они падали на хелперах, ищущих `document.querySelector('textarea')`,
// а не на поведении. Здесь то же поведение предъявлено на новой поверхности; остальные
// 319 тестов набора прошли без правок вовсе.
//
// Чего этот файл НЕ доказывает (и что обязан проверить человек в браузере): реальный
// IME, вставку из внешних редакторов и отсутствие лага на 30 строках. happy-dom держит
// Selection/Range, но лэйаута у него нет (`getClientRects` отдаёт нули).

afterEach(cleanup)

const line = () => document.querySelector('[data-rich-line]') as HTMLElement

// reactiveRow — строка, подписанная на стор (как в focusContract.test.tsx): value
// поверхности обязан отражать набор, иначе вырезание «/» и конверсию не проверить.
function reactiveRow(text = '', type: 'text' | 'title' = 'text') {
  const store = createBuilderStore()
  const schema: FormSchema = {
    schemaVersion: 3,
    blocks: [{ id: 't', groupId: 'g1', type, text: textFromString(text) }],
  }
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  function Row() {
    const blocks = useStore(store, (s) => s.blocks)
    const b = blocks[0]
    if (!b) return null
    return (
      <BlockRow
        block={b}
        formId="f"
        groupHandle={null}
        openMenuOnMount={false}
        onAddBelow={handlers.onAddBelow}
        onInsertBelow={vi.fn()}
        onBackspaceAtStart={handlers.onBackspaceAtStart}
        onBackspaceDelete={vi.fn()}
        onDeleteBlock={vi.fn()}
        onAnswerAction={vi.fn()}
        onArrow={handlers.onArrow}
        onRowShift={vi.fn()}
      />
    )
  }
  const handlers = {
    onAddBelow: vi.fn(),
    onBackspaceAtStart: vi.fn(),
    onArrow: vi.fn(),
  }
  render(
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <DndContext>
          <SortableContext items={['t']}>
            <Row />
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store, engine, handlers }
}

// lastTextNode — узел, в который браузер дописал бы очередной символ.
function lastTextNode(el: HTMLElement): Text | null {
  let out: Text | null = null
  const walk = (n: Node) => {
    if (n.nodeType === 3) out = n as Text
    else n.childNodes.forEach(walk)
  }
  walk(el)
  return out
}

// typeRich — посимвольный набор в contenteditable: браузер сам пишет символ в DOM и
// двигает каретку, поэтому тест делает то же и шлёт `input`. Посимвольность важна:
// инлайн-слеш триггерится, только когда «/» стоит прямо перед кареткой (§3.5).
//
// Символ ДОПИСЫВАЕТСЯ в последний текстовый узел, а не переприсваивается в
// `el.textContent`: переприсваивание сносит размеченные узлы, то есть тест сам делал бы
// то, за отсутствие чего ручается конструкция, и проверка марок выродилась бы в
// проверку самого хелпера.
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

describe('фокус-цель строки (§2.1 EDITOR.md) на новой поверхности', () => {
  it('подпись получает фокус, и на ней её текст', () => {
    const { engine } = reactiveRow('Вопрос', 'title')
    engine.focusBlock('t', 'end')
    expect(document.activeElement).toBe(line())
    expect(line().textContent).toBe('Вопрос')
  })

  it('край каретки: start → в начало, end → в конец текста', () => {
    const { engine } = reactiveRow('Привет', 'title')
    engine.focusBlock('t', 'start')
    expect(richCaret(line()).text().caret).toBe(0)
    expect(richCaret(line()).caretAtStart()).toBe(true)
    engine.focusBlock('t', 'end')
    expect(richCaret(line()).text().caret).toBe(6)
    expect(richCaret(line()).caretAtEnd()).toBe(true)
  })
})

describe('инлайн-слеш (§3.5) на новой поверхности', () => {
  it('«/» открывает меню; литерал остаётся в тексте, каретка не покидает строку', () => {
    const { store } = reactiveRow()
    line().focus()
    typeRich('/')
    expect(plainText(store.getState().blocks[0]!.text)).toBe('/')
    expect(document.body.textContent).toContain('Короткий ответ')
    expect(document.activeElement).toBe(line())
  })

  it('набор после «/» фильтрует пункты', () => {
    reactiveRow()
    typeRich('/email')
    const menu = document.querySelector('[role="listbox"]')!.textContent ?? ''
    expect(menu).toContain('Email')
    expect(menu).not.toContain('Дата')
  })

  it('несовпадение («и/или») закрывает меню, текст сохраняется', () => {
    const { store } = reactiveRow('и')
    typeRich('и/или')
    expect(plainText(store.getState().blocks[0]!.text)).toBe('и/или')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('Esc закрывает меню, «/» остаётся в тексте', () => {
    const { store } = reactiveRow()
    typeRich('/')
    fireEvent.keyDown(line(), { key: 'Escape', code: 'Escape' })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(plainText(store.getState().blocks[0]!.text)).toBe('/')
  })

  it('выбор вырезает «/»+фильтр и конвертирует (Вопрос: подпись+поле)', () => {
    const { store } = reactiveRow()
    typeRich('/email')
    fireEvent.keyDown(line(), { key: 'Enter', code: 'Enter' })
    const blocks = store.getState().blocks
    expect(blocks.map((b) => b.type)).toEqual(['title', 'email'])
    expect(plainText(blocks[0]!.text)).toBe('')
  })

  it('текст перед «/» становится подписью поля', () => {
    const { store } = reactiveRow('Возраст')
    typeRich('Возраст/')
    fireEvent.keyDown(line(), { key: 'Enter', code: 'Enter' })
    expect(plainText(store.getState().blocks[0]!.text)).toBe('Возраст')
  })
})

describe('поток строки фазы 13 цел', () => {
  it('Enter зовёт «новый блок после группы», а не печатает перенос', () => {
    const { handlers } = reactiveRow('Текст')
    fireEvent.keyDown(line(), { key: 'Enter', code: 'Enter' })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('t', { inside: false })
  })

  it('Backspace в начале строки схлопывает блок, а не удаляет символ', () => {
    const { engine, handlers } = reactiveRow('Текст')
    engine.focusBlock('t', 'start')
    fireEvent.keyDown(line(), { key: 'Backspace', code: 'Backspace' })
    expect(handlers.onBackspaceAtStart).toHaveBeenCalledWith('t')
  })

  it('Backspace НЕ в начале строки уходит в текст (блок не схлопывается)', () => {
    const { engine, handlers } = reactiveRow('Текст')
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(line(), { key: 'Backspace', code: 'Backspace' })
    expect(handlers.onBackspaceAtStart).not.toHaveBeenCalled()
  })

  it('↓ в конце строки уходит на соседнюю, ↑ в конце — нет', () => {
    const { engine, handlers } = reactiveRow('Текст')
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(line(), { key: 'ArrowDown', code: 'ArrowDown' })
    expect(handlers.onArrow).toHaveBeenCalledWith('t', 'down')
    handlers.onArrow.mockClear()
    fireEvent.keyDown(line(), { key: 'ArrowUp', code: 'ArrowUp' })
    expect(handlers.onArrow).not.toHaveBeenCalled()
  })
})

describe('каретка переживает ре-рендер полотна на каждый символ (риск TD-32)', () => {
  it('после набора каретка там, где её оставили, а не в начале и не в body', () => {
    reactiveRow()
    line().focus()
    typeRich('привет')
    expect(document.activeElement).toBe(line())
    expect(richCaret(line()).text().caret).toBe(6)
    expect(line().textContent).toBe('привет')
  })

  // Проверка сторожа ресинка. Каретку happy-dom различить не даёт (без сторожа эффект
  // перепечатывает DOM и тут же ставит каретку обратно — тест зелёный в обоих случаях,
  // проверено мутацией), а вот РАЗМЕТКУ перепечатка сносит: она восстанавливает строку
  // из плоского текста стора. Поэтому сторожа ловит именно эта проверка.
  it('набор после форматирования не стирает марку (сторож ресинка)', () => {
    reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, { key: 'b', code: 'KeyB', ctrlKey: true })
    typeRich('абвгдЕ')
    expect(spansFromDom(line())).toEqual([{ t: 'а' }, { t: 'бв', m: ['b'] }, { t: 'гдЕ' }])
  })

  it('набор в СЕРЕДИНЕ текста не отбрасывает каретку в конец', () => {
    reactiveRow('абвг')
    const el = line()
    el.focus()
    el.textContent = 'абХвг'
    setCaret(el, 3)
    fireEvent.input(el)
    expect(richCaret(line()).text().caret).toBe(3)
  })
})

describe('марки поверх модели', () => {
  it('Mod+B кладёт жирный на выделение и сохраняет плоский текст', () => {
    const { store } = reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(spansFromDom(line())).toEqual([{ t: 'а' }, { t: 'бв', m: ['b'] }, { t: 'гд' }])
    // Плоский текст форматирование не меняет — в сторе он прежний.
    expect(plainText(store.getState().blocks[0]!.text)).toBe('абвгд')
  })

  // Найдено владельцем при первой браузерной проверке: Mod+B занят вендоренным
  // сайдбаром shadcn — слушателем на window (`components/ui/sidebar.tsx:100`).
  // preventDefault его не останавливает: он про действие браузера, а не про всплытие.
  it('Mod+B не доходит до window — сайдбар не схлопывается вместе с жирным', () => {
    reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    const onWindow = vi.fn()
    window.addEventListener('keydown', onWindow)
    fireEvent.keyDown(el, { key: 'b', code: 'KeyB', ctrlKey: true })
    window.removeEventListener('keydown', onWindow)
    expect(onWindow).not.toHaveBeenCalled()
  })

  it('Mod+B со схлопнутой кареткой ничего не делает и не роняет строку', () => {
    reactiveRow('абвгд')
    const el = line()
    el.focus()
    setCaret(el, 2)
    fireEvent.keyDown(el, { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(line().textContent).toBe('абвгд')
  })

  it('повторный Mod+B снимает жирный и возвращает документ к одному куску', () => {
    reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, { key: 'b', code: 'KeyB', ctrlKey: true })
    setSelection(line(), 1, 3)
    fireEvent.keyDown(line(), { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(spansFromDom(line())).toEqual([{ t: 'абвгд' }])
  })
})
