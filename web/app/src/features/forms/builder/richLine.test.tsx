// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useStore } from 'zustand'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type FormSchema, MAX_SPANS, type Span, plainText, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'
import { richCaret, setCaret, setSelection } from './richCaret'
import { spansFromDom } from './richText'

// Текстовая поверхность строки полотна (фаза 14, этап 14.3). Главное утверждение,
// которое здесь предъявляется: замена <textarea> на contenteditable НЕ переписала
// клавиатурный поток фазы 13. Инлайн-слеш (§3.5) живёт здесь целиком — он переехал из
// `focusContract.test.tsx`, потому что требует посимвольного набора в contenteditable,
// а такой хелпер уже про поверхность, а не про контракт фокуса.
//
// Чего этот файл НЕ доказывает (и что обязан проверить человек в браузере): реальный
// IME, вставку из внешних редакторов, отсутствие лага на 30 строках и то, как марка
// ВЫГЛЯДИТ. happy-dom держит Selection/Range, но лэйаута у него нет (`getClientRects`
// отдаёт нули), и правила `fields.css` в тестах не применяются.

afterEach(cleanup)

const line = () => document.querySelector('[data-rich-line]') as HTMLElement

// reactiveRow — строка, подписанная на стор (как в focusContract.test.tsx): value
// поверхности обязан отражать набор, иначе вырезание «/» и конверсию не проверить.
function reactiveRow(text: string | Span[] = '', type: 'text' | 'title' = 'text') {
  const store = createBuilderStore()
  const schema: FormSchema = {
    schemaVersion: 3,
    blocks: [
      { id: 't', groupId: 'g1', type, text: typeof text === 'string' ? textFromString(text) : text },
    ],
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

  // Строку, стёртую дочиста, обязано быть видно пустой — и в сторе, и на поверхности.
  // Браузер оставляет на её месте служебный <br> (без него contenteditable схлопывается
  // по высоте); пока он читался пробелом, ресинк писал этот пробел обратно настоящим, и
  // опустошить строку было нельзя вовсе — вместе с подсказкой, которая ждёт `:empty`.
  it('стёртая дочиста строка остаётся пустой, а не возвращается с пробелом', () => {
    const { store } = reactiveRow('а')
    const el = line()
    el.focus()
    el.textContent = ''
    el.appendChild(el.ownerDocument.createElement('br'))
    fireEvent.input(el)

    expect(store.getState().blocks[0]!.text).toEqual([])
    expect(line().textContent).toBe('')
  })
})

describe('марки поверх модели', () => {
  it('Mod+B кладёт жирный на выделение и ДОВОЗИТ его до стора', () => {
    const { store } = reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(spansFromDom(line())).toEqual([{ t: 'а' }, { t: 'бв', m: ['b'] }, { t: 'гд' }])
    // Главное отличие этапа 14.3 от пробы: разметка попадает в документ, а не живёт
    // только в DOM. Не доехала бы — её не увидели бы ни автосейв, ни отмена.
    expect(store.getState().blocks[0]!.text).toEqual([
      { t: 'а' },
      { t: 'бв', m: ['b'] },
      { t: 'гд' },
    ])
    // Плоский текст форматирование не меняет.
    expect(plainText(store.getState().blocks[0]!.text)).toBe('абвгд')
  })

  // Снимок выделения, на котором стоит панель, приезжает из `selectionchange` через
  // React — то есть ПОЗЖЕ нажатия: пока состояние догоняет, браузер успевает подвинуть
  // выделение ещё раз. Здесь эта гонка собрана руками: снимок набран на одном
  // диапазоне, живое выделение уже на другом — марка обязана лечь на живое. В браузере
  // расхождение стоило фазе 14 седьмого дефекта: `Shift+←` трижды и `Mod+B` красили
  // один символ из трёх (нашёл e2e этапа 14.5, юниты до этой проверки — нет).
  it('марка ложится на ЖИВОЕ выделение, а не на снимок прошлого кадра', () => {
    const { store } = reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 3, 5)
    fireEvent(document, new Event('selectionchange'))
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, { code: 'KeyB', ctrlKey: true })
    expect(store.getState().blocks[0]!.text).toEqual([
      { t: 'а' },
      { t: 'бв', m: ['b'] },
      { t: 'гд' },
    ])
  })

  // Список марок открыт по построению (§1 спеки): добавление марки — строка в MARKS,
  // строка в fields.css, кнопка в панель. Проверяем, что все четыре ходят одним путём,
  // а не четырьмя ветками в обработчике.
  it.each([
    ['Mod+B', { code: 'KeyB', ctrlKey: true }, 'b'],
    ['Mod+I', { code: 'KeyI', ctrlKey: true }, 'i'],
    ['Mod+U', { code: 'KeyU', ctrlKey: true }, 'u'],
    ['Mod+Shift+S', { code: 'KeyS', ctrlKey: true, shiftKey: true }, 's'],
  ])('%s ставит марку %s', (_name, chord, mark) => {
    const { store } = reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, chord)
    expect(store.getState().blocks[0]!.text).toEqual([
      { t: 'а' },
      { t: 'бв', m: [mark] },
      { t: 'гд' },
    ])
  })

  it('две марки на одном выделении складываются, а не вытесняют друг друга', () => {
    const { store } = reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, { code: 'KeyB', ctrlKey: true })
    setSelection(line(), 1, 3)
    fireEvent.keyDown(line(), { code: 'KeyI', ctrlKey: true })
    expect(store.getState().blocks[0]!.text?.[1]).toEqual({ t: 'бв', m: ['b', 'i'] })
  })

  // Ресинк из стора обязан вернуть разметку: undo — это внешняя правка, и поверхность
  // перепечатывается из модели. Без сравнения по значению здесь была бы либо потеря
  // марок (перепечатка на каждый символ), либо их застревание (ресинка нет вовсе).
  it('undo возвращает поверхность к состоянию до наложения марки', () => {
    const { store } = reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 1, 3)
    fireEvent.keyDown(el, { code: 'KeyB', ctrlKey: true })
    expect(spansFromDom(line())).toHaveLength(3)

    // act — не ритуал: undo меняет стор синхронно, но перерисовку React откладывает, и
    // без него проверялся бы DOM, до которого правка ещё не доехала.
    act(() => {
      store.getState().undo()
    })
    expect(store.getState().blocks[0]!.text).toEqual([{ t: 'абвгд' }])
    expect(spansFromDom(line())).toEqual([{ t: 'абвгд' }])
  })

  // Вырезание «/»+фильтра идёт по координатам текста, а не склейкой строк: иначе
  // выбор пункта меню стирал бы разметку всей подписи.
  it('слеш-меню вырезает свой текст, не трогая разметку остального', () => {
    const { store } = reactiveRow('абвгд')
    const el = line()
    el.focus()
    setSelection(el, 0, 2)
    fireEvent.keyDown(el, { code: 'KeyB', ctrlKey: true })
    // Набираем «/» в конце и выбираем первый пункт меню.
    setCaret(line(), 5)
    typeRich('абвгд/')
    fireEvent.keyDown(line(), { key: 'Enter', code: 'Enter' })
    const title = store.getState().blocks[0]!
    expect(title.type).toBe('title')
    expect(title.text).toEqual([{ t: 'аб', m: ['b'] }, { t: 'вгд' }])
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

// Панель форматирования (этап 14.4, §3.3 спеки). Живое выделение в happy-dom
// событие `selectionchange` само не рождает, поэтому тест шлёт его руками сразу после
// установки диапазона — ровно то, что делает браузер. Позицию панели тесты не
// проверяют вовсе: `getClientRects` у happy-dom отдаёт нули, и это работа браузера.
function selectText(from: number, to: number) {
  const el = line()
  el.focus()
  setSelection(el, from, to)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

const bar = () => document.querySelector('[data-format-bar]')
const barBtn = (label: string) =>
  document.querySelector(`[data-format-bar] [aria-label="${label}"]`) as HTMLElement
// Выборщик цвета — поповер за кнопкой панели. Мышью по градиенту `react-colorful` в
// happy-dom не повозишь (лэйаута нет), поэтому тесты ходят через его же поле hex: путь
// «значение → модель» у них общий.
const colorPopover = (which: 'color' | 'bg') =>
  document.querySelector(`[data-color-popover="${which}"]`)
const openPicker = (which: 'color' | 'bg') => {
  fireEvent.click(barBtn(which === 'color' ? 'Цвет текста' : 'Цвет фона'))
  return document.querySelector(
    `[data-color-popover="${which}"] [aria-label="Свой цвет"]`,
  ) as HTMLInputElement
}

describe('панель форматирования', () => {
  it('появляется над непустым выделением и исчезает, когда его нет', () => {
    reactiveRow('абвгд')
    expect(bar()).toBeNull()
    selectText(1, 3)
    expect(bar()).not.toBeNull()

    setCaret(line(), 2)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(bar()).toBeNull()
  })

  // Правило, без которого панель ломается тихо: ушедший фокус схлопывает выделение, и
  // кнопка применяет марку к пустоте. Симптом обманчив — «кнопка не работает».
  it('не забирает фокус: mousedown на панели погашен', () => {
    reactiveRow('абвгд')
    selectText(1, 3)
    const prevented = !fireEvent.mouseDown(bar()!)
    expect(prevented).toBe(true)
    expect(document.activeElement).toBe(line())
  })

  it('кнопка марки применяет её к выделению и показывается нажатой', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.click(barBtn('Жирный'))
    expect(store.getState().blocks[0]!.text).toEqual([
      { t: 'а' },
      { t: 'бв', m: ['b'] },
      { t: 'гд' },
    ])
    expect(barBtn('Жирный').getAttribute('aria-pressed')).toBe('true')
  })

  it('выборщик цвета кладёт значение в том виде, которого требует валидатор', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.change(openPicker('color'), { target: { value: '#C026D3' } })
    // Нижний регистр — не косметика: `#rrggbb` в нём требует HEX_COLOR схемы, и
    // выборщик отдаёт то, что автор набрал.
    expect(store.getState().blocks[0]!.text?.[1]).toEqual({ t: 'бв', color: '#c026d3' })
  })

  it('фон — та же механика, своё поле спана', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.change(openPicker('bg'), { target: { value: '#ffff00' } })
    expect(store.getState().blocks[0]!.text?.[1]).toEqual({ t: 'бв', bg: '#ffff00' })
  })

  it('образец из сетки кладёт свой цвет как есть', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    openPicker('bg')
    fireEvent.click(document.querySelector('[data-color-popover="bg"] [aria-label="#fef08a"]')!)
    expect(store.getState().blocks[0]!.text?.[1]).toEqual({ t: 'бв', bg: '#fef08a' })
  })

  // За каждым движением по выборщику стоит весь путь «модель → DOM строки → стор →
  // полотно». Событий указателя браузер шлёт больше, чем рисует кадров, поэтому без
  // склейки бо́льшая часть этой цепочки выполняется впустую — так жест и ощущается
  // вязким. Здесь предъявляется, что три движения внутри одного кадра дают ОДНУ правку,
  // и правка эта — по последней позиции, а не по первой.
  it('перетаскивание по полосе тона считает цвет раз в кадр, по последней позиции', async () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    openPicker('color')
    const hue = document.querySelector(
      '[data-color-popover="color"] [aria-label="Тон"]',
    ) as HTMLElement
    // Лэйаута у happy-dom нет — область меряет себя нулями и жест бы не начался.
    hue.getBoundingClientRect = () => new DOMRect(0, 0, 360, 12)

    let writes = 0
    const stop = store.subscribe(() => {
      writes++
    })
    fireEvent.pointerDown(hue, { pointerId: 1, clientX: 0, clientY: 6 })
    fireEvent.pointerMove(hue, { pointerId: 1, clientX: 60, clientY: 6 })
    fireEvent.pointerMove(hue, { pointerId: 1, clientX: 120, clientY: 6 })
    fireEvent.pointerMove(hue, { pointerId: 1, clientX: 180, clientY: 6 })
    fireEvent.pointerUp(hue, { pointerId: 1, clientX: 180, clientY: 6 })
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    stop()

    expect(writes).toBe(1)
    // 180 из 360 — середина полосы, тон бирюзовый. Не чистый `#00ffff`: полоса меняет
    // ТОЛЬКО тон, насыщенность и яркость остаются от исходного `#1d4ed8`. Значение от
    // последней позиции, а не от первой (иначе тут был бы синий).
    expect(store.getState().blocks[0]!.text?.[1]).toEqual({ t: 'бв', color: '#1dd8d8' })
  })

  it('«Убрать» снимает цвет и возвращает документ к одному куску', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.change(openPicker('color'), { target: { value: '#c026d3' } })
    // Поповер после выбора остаётся открытым — цвет подбирают, а не угадывают с раза.
    fireEvent.click(barBtn('Убрать цвет текста'))
    expect(store.getState().blocks[0]!.text).toEqual([{ t: 'абвгд' }])
  })
})

// Лимит числа кусков — единственный из лимитов схемы, до которого можно доехать одним
// редактором: набор кусков не плодит (канон склеивает соседей), а марка на середину
// куска режет его на три. Раньше перебор уезжал в автосейв и возвращался оттуда как
// «ошибка сохранения» — без причины и без указания, какая правка её вызвала.
describe('лимит кусков оформления', () => {
  // Ровно предельный документ: MAX_SPANS кусков по два символа, через один жирные.
  const atLimit = (): Span[] =>
    Array.from({ length: MAX_SPANS }, (_, i) => (i % 2 ? { t: 'аб', m: ['b' as const] } : { t: 'вг' }))

  it('форматирование, переваливающее лимит, не применяется', () => {
    const { store } = reactiveRow(atLimit())
    // Половина первого куска: разрез добавит спан, то есть выведет за предел.
    selectText(0, 1)
    fireEvent.keyDown(line(), { code: 'KeyI', ctrlKey: true })

    expect(store.getState().blocks[0]!.text).toEqual(atLimit())
  })

  it('форматирование, не выводящее за предел, применяется как обычно', () => {
    const { store } = reactiveRow(atLimit().slice(0, MAX_SPANS - 2))
    selectText(0, 1)
    fireEvent.keyDown(line(), { code: 'KeyI', ctrlKey: true })

    expect(store.getState().blocks[0]!.text?.[0]).toEqual({ t: 'в', m: ['i'] })
  })
})

describe('ссылка (панель + Mod+K)', () => {
  const linkInput = () => barBtn('Адрес ссылки') as HTMLInputElement

  it('Mod+K открывает поле адреса, Enter применяет ссылку', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.keyDown(line(), { code: 'KeyK', ctrlKey: true })
    fireEvent.change(linkInput(), { target: { value: 'https://trillix.ru/p' } })
    fireEvent.keyDown(linkInput(), { key: 'Enter' })
    expect(store.getState().blocks[0]!.text?.[1]).toEqual({
      t: 'бв',
      href: 'https://trillix.ru/p',
    })
  })

  // Инвариант 4: тот же валидатор, что у redirectUrl. Схема такое всё равно отвергнет
  // (422), но давать автору сохранить заведомо битую ссылку и узнать об этом от
  // автосейва — худший из способов сообщить об ошибке.
  it.each(['javascript:alert(1)', 'data:text/html,x', '/privacy', 'трилликс'])(
    'негодный адрес %s не применяется',
    (bad) => {
      const { store } = reactiveRow('абвгд')
      selectText(1, 3)
      fireEvent.keyDown(line(), { code: 'KeyK', ctrlKey: true })
      fireEvent.change(linkInput(), { target: { value: bad } })
      fireEvent.keyDown(linkInput(), { key: 'Enter' })
      expect(store.getState().blocks[0]!.text).toEqual([{ t: 'абвгд' }])
    },
  )

  // Адрес люди копируют и диктуют без схемы. Дописываем её за автора — но только тому,
  // что похоже на хост: иначе набранное слово («трилликс», проверка выше) молча
  // становилось бы ссылкой в никуда.
  it('адрес без схемы получает https://', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.keyDown(line(), { code: 'KeyK', ctrlKey: true })
    fireEvent.change(linkInput(), { target: { value: '  trillix.ru/privacy  ' } })
    fireEvent.keyDown(linkInput(), { key: 'Enter' })
    expect(store.getState().blocks[0]!.text?.[1]).toEqual({
      t: 'бв',
      href: 'https://trillix.ru/privacy',
    })
  })

  it('«Убрать ссылку» снимает её и возвращает документ к одному куску', () => {
    const { store } = reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.keyDown(line(), { code: 'KeyK', ctrlKey: true })
    fireEvent.change(linkInput(), { target: { value: 'https://a.ru' } })
    fireEvent.keyDown(linkInput(), { key: 'Enter' })

    selectText(1, 3)
    fireEvent.click(barBtn('Ссылка'))
    fireEvent.click(barBtn('Убрать ссылку'))
    expect(store.getState().blocks[0]!.text).toEqual([{ t: 'абвгд' }])
  })
})

// Оба дефекта найдены владельцем в браузере 2026-07-27 — тестами они не ловились,
// потому что оба про доставку события мыши, а не про модель.
describe('панель: два дефекта первой браузерной проверки', () => {
  it('клик мимо строки и мимо панели закрывает меню ссылки', () => {
    reactiveRow('абвгд')
    selectText(1, 3)
    fireEvent.keyDown(line(), { code: 'KeyK', ctrlKey: true })
    expect(barBtn('Адрес ссылки')).not.toBeNull()

    // Blur самой строки этот случай не покрывает: фокус уже в поле адреса, и её blur
    // давно прошёл. Закрывать обязан отдельный слушатель на документе.
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(bar()).toBeNull()
  })

  it('клик по панели её НЕ закрывает', () => {
    reactiveRow('абвгд')
    selectText(1, 3)
    act(() => {
      fireEvent.mouseDown(barBtn('Жирный'))
    })
    expect(bar()).not.toBeNull()
  })

  // Цвет было невозможно поменять: кнопка была меткой `<label>` вокруг спрятанного
  // `<input type="color">`. Метка фокус не принимает, панель порталится на body, и
  // mousedown по метке уводил фокус из строки В НИКУДА — строка на своём blur закрывала
  // панель ВНУТРИ того же mousedown, а обещанный меткой click приходить было уже некуда.
  // Палитра не открывалась вовсе.
  it.each([
    ['Цвет текста', 'color'],
    ['Цвет фона', 'bg'],
  ] as const)('%s: нажатие открывает выборщик, а не гасит панель', (label, which) => {
    reactiveRow('абвгд')
    selectText(1, 3)

    // mousedown погашен общим гардом панели → фокус и выделение остаются в строке.
    const prevented = !fireEvent.mouseDown(barBtn(label))
    expect(prevented).toBe(true)
    expect(document.activeElement).toBe(line())
    expect(bar()).not.toBeNull()

    fireEvent.click(barBtn(label))
    expect(colorPopover(which)).not.toBeNull()
  })

  // Поповер порталится ОТДЕЛЬНО от панели, поэтому носит её метку `data-format-bar`:
  // иначе и слушатель «клик мимо», и blur строки считают уход в него уходом наружу —
  // панель закрывалась бы прямо под курсором вместе с выборщиком.
  it('клик внутри выборщика цвета не закрывает панель', () => {
    reactiveRow('абвгд')
    selectText(1, 3)
    openPicker('color')

    // Пустое место поповера — там, где своего обработчика нет: именно оно и уводило бы
    // фокус в никуда, схлопывая панель вместе с выборщиком.
    const prevented = !fireEvent.mouseDown(colorPopover('color')!)
    expect(prevented).toBe(true)
    expect(document.activeElement).toBe(line())
    expect(bar()).not.toBeNull()
    expect(colorPopover('color')).not.toBeNull()
  })

  it('кнопки марок по-прежнему фокус не забирают', () => {
    reactiveRow('абвгд')
    selectText(1, 3)
    const notPrevented = fireEvent.mouseDown(barBtn('Жирный'))
    expect(notPrevented).toBe(false)
  })

  // Выборщик цвета шлёт команду форматирования КАДРАМИ, а диапазон и марки при этом не
  // меняются. Держат это две защиты: снимок выделения не пересоздаётся, когда он тот же
  // (`sameSel`), и эффекты завязаны на факт «панель открыта», а не на сам снимок. Тест
  // краснеет, если снять ОБЕ, — каждой по отдельности хватает; вторая не лишняя, потому
  // что `sameSel` бережёт ещё и ре-рендер панели с пересчётом позиции поповера, а это
  // отсюда не видно.
  it('неизменившееся выделение не пересоздаёт снимок и не дёргает эффекты', () => {
    reactiveRow('абвгд')
    selectText(1, 3)

    const add = vi.spyOn(document, 'addEventListener')
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(add.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(0)
    add.mockRestore()
  })
})

// Замок прокрутки (решение владельца 2026-07-27): панель стоит по координатам
// выделения, снятым один раз, и прокрутка увезла бы текст из-под неё.
//
// Замок НИЧЕГО не прячет и не двигает — только гасит события. Поэтому и проверять тут
// нечего, кроме них: лэйаут при открытии панели не меняется вовсе.
describe('замок прокрутки на время панели', () => {
  it('гасит колесо и тач, пока панель открыта, и отпускает после', () => {
    reactiveRow('абвгд')
    expect(fireEvent.wheel(document.body)).toBe(true)

    selectText(1, 3)
    expect(fireEvent.wheel(document.body)).toBe(false)
    expect(fireEvent.touchMove(document.body)).toBe(false)

    setCaret(line(), 2)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(fireEvent.wheel(document.body)).toBe(true)
  })

  // Лэйаут не трогается вовсе — ни overflow, ни отступов. Две предыдущие версии
  // прятали полосу прокрутки и компенсировали её паддингом: обе давали дёрганье
  // экрана, вторая вдобавок ломала шапку кабинета (найдено владельцем в браузере).
  it('не трогает ни overflow, ни отступы', () => {
    reactiveRow('абвгд')
    selectText(1, 3)
    for (const el of [document.documentElement, document.body]) {
      expect(el.style.overflow).toBe('')
      expect(el.style.paddingRight).toBe('')
    }
  })
})
