// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { type FormSchema, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { SlashEditor } from './SlashEditor'
import { setCaret } from './richCaret'

// Схлопывание пустой строки Backspace'ом (§3.2 EDITOR.md) — жест, который держит всю
// клавиатурную сборку формы: строка, которую нельзя убрать той же клавишей, какой её
// набрали, ломает обещание «полотно ведёт себя как текстовый документ».
//
// Тест смонтирован на ЦЕЛОМ полотне, а не на одной строке, намеренно: решение
// принимает `SlashEditor` (он один знает соседей), а `BlockRow` только зовёт его
// колбэк — проверка на уровне строки этого не видит и не увидела, когда жест сломался.
//
// Сломался он на переходе к богатому тексту: `text` стал массивом спанов, а проверка
// «пусто» осталась сравнением с пустой строкой. Типы это пропускают (`Span[] | ''`
// пересекается с `''`), тесты уровня строки — тоже.

afterEach(cleanup)

function setup(blocks: FormSchema['blocks']) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: 3, blocks })
  const engine = createFocusEngine()
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <BuilderStoreContext.Provider value={store}>
        <FocusEngineProvider value={engine}>
          <SlashEditor formId="f" initialTitle="Опрос" engine={engine} />
        </FocusEngineProvider>
      </BuilderStoreContext.Provider>
    </QueryClientProvider>,
  )
  return { store }
}

// backspaceAtStart — каретка в начало строки и Backspace, как это делает человек.
function backspaceAtStart(index: number) {
  const el = document.querySelectorAll('[data-rich-line]')[index] as HTMLElement
  el.focus()
  setCaret(el, 0)
  fireEvent.keyDown(el, { key: 'Backspace', code: 'Backspace' })
}

describe('Backspace в начале строки', () => {
  it('пустая строка схлопывается — блок исчезает с полотна', () => {
    const { store } = setup([
      { id: 'a', groupId: 'g1', type: 'text', text: textFromString('Абзац') },
      { id: 'b', groupId: 'g2', type: 'text', text: [] },
    ])

    backspaceAtStart(1)

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['a'])
  })

  it('строка с текстом Backspace\'ом не удаляется', () => {
    const { store } = setup([
      { id: 'a', groupId: 'g1', type: 'text', text: textFromString('Абзац') },
      { id: 'b', groupId: 'g2', type: 'text', text: textFromString('Второй') },
    ])

    backspaceAtStart(1)

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('пустая ПОДПИСЬ сносит группу целиком — поле не остаётся сиротой', () => {
    const { store } = setup([
      { id: 'a', groupId: 'g1', type: 'text', text: textFromString('Абзац') },
      { id: 't', groupId: 'g2', type: 'title', text: [] },
      { id: 'f', groupId: 'g2', type: 'short_text', settings: {} },
    ])

    backspaceAtStart(1)

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['a'])
  })
})
