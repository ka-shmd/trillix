// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { type FormSchema, plainText, textFromString, SCHEMA_VERSION } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { SlashEditor } from './SlashEditor'
import { setCaret } from './richCaret'

// Enter и Shift+Enter на полотне (решение владельца 2026-08-22, отменяет жест
// «Shift+Enter — новый блок внутрь вопроса»):
//
//   • Enter кладёт новую строку СРАЗУ ПОД текущей и через поле ответа не перепрыгивает;
//   • Shift+Enter — обычный перенос строки внутри блока, блоков не прибавляется.
//
// Тест смонтирован на ЦЕЛОМ полотне по той же причине, что `canvasBackspace`: место
// вставки считает `SlashEditor` (он один видит соседей блока), а `BlockRow` только зовёт
// его колбэк — проверка на уровне строки этого не видит.

afterEach(cleanup)

function setup(blocks: FormSchema['blocks']) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  const engine = createFocusEngine()
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <BuilderStoreContext.Provider value={store}>
        <FocusEngineProvider value={engine}>
          <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
        </FocusEngineProvider>
      </BuilderStoreContext.Provider>
    </QueryClientProvider>,
  )
  return { store }
}

// Каретка в конец строки и нажатие — как это делает человек, дописав вопрос.
function pressAtEnd(index: number, init: Record<string, unknown>) {
  const el = document.querySelectorAll('[data-rich-line]')[index] as HTMLElement
  el.focus()
  setCaret(el, (el.textContent ?? '').length)
  fireEvent.keyDown(el, init)
}

const enter = (index: number) => pressAtEnd(index, { key: 'Enter', code: 'Enter' })
const shiftEnter = (index: number) =>
  pressAtEnd(index, { key: 'Enter', code: 'Enter', shiftKey: true })

const types = (store: ReturnType<typeof setup>['store']) =>
  store.getState().blocks.map((b) => b.type)
const columns = (store: ReturnType<typeof setup>['store']) =>
  store.getState().blocks.map((b) => b.settings?.column ?? '-')

describe('Enter — новая строка сразу под текущей', () => {
  it('с подписи собранного вопроса строка встаёт ПЕРЕД полем, в том же вопросе', () => {
    const { store } = setup([
      { id: 't', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
      { id: 'f', groupId: 'g1', type: 'short_text', settings: {} },
    ])

    enter(0)

    // Ровно то, чего просил владелец: строка не перепрыгнула через поле ответа.
    expect(types(store)).toEqual(['title', 'text', 'short_text'])
    const s = store.getState().blocks
    expect(s[1]!.groupId).toBe(s[0]!.groupId)
  })

  // Отчёт владельца 2026-08-23: «внутри группы текст на текстовом блоке отличается от
  // обычного». Строка внутри вопроса звалась «Пояснение к вопросу» — отдельным жанром
  // блока. Пока такую строку заводили редким Shift+Enter, разница была незаметна; как
  // только её стал заводить Enter, одна и та же клавиша начала давать то строку, то
  // «пояснение», и подпись вдобавок прятала «/».
  //
  // Проверка на ЦЕЛОМ полотне обязательна: признак «внутри вопроса» считает SlashEditor
  // по составу группы, и строке, отрисованной в одиночку, он всегда приходит ложью —
  // тест уровня строки эту ветку не проходит вовсе.
  it('строка, рождённая внутри вопроса, зовётся как обычный абзац', () => {
    const { store } = setup([
      { id: 't', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
      { id: 'f', groupId: 'g1', type: 'short_text', settings: {} },
    ])

    enter(0)

    const fresh = store.getState().blocks[1]!.id
    const line = document.querySelector(`[data-block-id="${fresh}"] [data-rich-line]`)
    expect(line?.getAttribute('aria-label')).toBe('Напечатайте «/», чтобы выбрать блок')
  })

  it('с последней строки группы — под ней же (одиночкой)', () => {
    const { store } = setup([
      { id: 'a', groupId: 'g1', type: 'text', text: textFromString('Абзац') },
      { id: 'b', groupId: 'g2', type: 'heading', text: textFromString('Раздел') },
    ])

    enter(0)

    expect(types(store)).toEqual(['text', 'text', 'heading'])
    const s = store.getState().blocks
    expect(s[1]!.groupId).not.toBe(s[0]!.groupId)
  })

  it('вопрос в колонке: строка встаёт внутрь него, секция цела', () => {
    // Вставка ВНУТРЬ группы состав секции не меняет (`sectionMates` считает компанию
    // группами, а не блоками), поэтому исключение §13 сюда не нужно — оно для строки,
    // ПОСЛЕДНЕЙ в своей группе, и проверено в store.test.ts.
    const { store } = setup([
      { id: 'a', groupId: 'g1', type: 'short_text', settings: {} },
      { id: 'b', groupId: 'g2', type: 'title', text: textFromString('Правая') },
      { id: 'c', groupId: 'g2', type: 'email', settings: {} },
    ])
    // groupId выводит regroup, поэтому ряд собираем по ЖИВЫМ id, а не по тем, что в
    // снимке выше: hydrate их переименовал.
    const gs = store.getState().blocks
    store.getState().placeInRow(gs[1]!.groupId, gs[0]!.groupId, 2, true)
    const before = columns(store)
    expect(before).toEqual([1, 2, '-'])

    enter(0) // подпись правой колонки: под ней в группе есть поле — значит внутрь

    expect(types(store)).toEqual(['short_text', 'title', 'text', 'email'])
    expect(columns(store)).toEqual([1, 2, '-', '-'])
  })
})

describe('Shift+Enter — перенос строки внутри блока', () => {
  it('добавляет \\n в текст и не рождает блока', () => {
    const { store } = setup([
      { id: 'a', groupId: 'g1', type: 'text', text: textFromString('Первая') },
    ])

    shiftEnter(0)

    expect(store.getState().blocks).toHaveLength(1)
    expect(plainText(store.getState().blocks[0]!.text)).toBe('Первая\n')
  })

  it('оформление куска перенос не начинает заново — он продолжает текст', () => {
    const { store } = setup([
      { id: 'a', groupId: 'g1', type: 'text', text: [{ t: 'Жир', m: ['b'] }] },
    ])

    shiftEnter(0)

    // Один кусок, а не два: канон склеил перенос с текстом, которому он принадлежит.
    expect(store.getState().blocks[0]!.text).toEqual([{ t: 'Жир\n', m: ['b'] }])
  })

  it('в заголовке формы перенос тоже работает (решение владельца 2026-08-22)', () => {
    const { store } = setup([
      { id: 'ft', groupId: 'g0', type: 'form_title', text: textFromString('Заголовок') },
      { id: 'a', groupId: 'g1', type: 'text', text: textFromString('Абзац') },
    ])

    shiftEnter(0) // первая rich-строка полотна — заголовок формы

    expect(store.getState().blocks).toHaveLength(2)
    expect(plainText(store.getState().blocks[0]!.text)).toBe('Заголовок\n')
  })
})
