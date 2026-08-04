// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { act, cleanup, render } from '@testing-library/react'

import { type FormSchema, SCHEMA_VERSION, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine } from './focusEngine'
import { SlashEditor } from './SlashEditor'

// СТОРОЖ МЕМОИЗАЦИИ ПОЛОТНА (TD-32).
//
// Дефект, который он держит: правка ОДНОГО блока перерисовывала ВСЕ строки формы.
// Полотно подписано на весь массив blocks, и любая правка отдаёт новый массив —
// дальше по цепочке пересобираются группы, списки id и, главное, значение контекста
// SortableContext, которое протягивается через каждый useSortable. У потолка
// MAX_BLOCKS это стоило 30 мс и 400 мутаций DOM на КАЖДЫЙ введённый символ (замер
// 2026-08-03, оснастка — e2e/perf).
//
// ПОЧЕМУ ИМЕННО ТАК ИЗМЕРЯЕТСЯ. Считать «сколько раз вызвался компонент» здесь
// нечем — строки рисует само полотно, подменять их нельзя, а счётчик внутри строки
// был бы продакшн-кодом ради теста. Поэтому меряется СЛЕДСТВИЕ, ради которого всё и
// затевалось: сколько строк полотна React ТРОНУЛ в DOM. Признак строки тот же, каким
// её узнаёт сам редактор, — ближайший предок с data-block-id.
//
// Тест мутационно-чувствителен: снимите memo с BlockRow, или верните нестабильный
// колбэк в пропсы строки, или посчитайте blockIds от идентичности массива вместо его
// содержимого — и число тронутых строк сразу станет «все».

afterEach(cleanup)

// Форма из n вопросов: подпись + короткий ответ, как их кладёт вопрос-бандл.
function schema(n: number): FormSchema {
  const blocks: FormSchema['blocks'] = [
    { id: 'ft', groupId: 'gft', type: 'form_title', text: textFromString('Форма') },
  ]
  for (let i = 0; i < n; i++) {
    blocks.push({ id: `c${i}`, groupId: `g${i}`, type: 'title', text: textFromString(`Вопрос ${i}`) })
    blocks.push({ id: `f${i}`, groupId: `g${i}`, type: 'short_text', settings: {} })
  }
  return { schemaVersion: SCHEMA_VERSION, blocks }
}

function mount(n: number) {
  const store = createBuilderStore()
  store.getState().hydrate(schema(n))
  const engine = createFocusEngine()
  const { container } = render(
    <BuilderStoreContext.Provider value={store}>
      <SlashEditor formId="f" engine={engine} />
    </BuilderStoreContext.Provider>,
  )
  return { store, container }
}

// Строки, которых коснулась перерисовка: по мутациям DOM за время действия.
// takeRecords, а не колбэк наблюдателя: он отдаёт накопленное СИНХРОННО, и тесту не
// приходится ждать микрозадачу, гадая, все ли записи доехали.
function touchedRows(container: HTMLElement, action: () => void): Set<string> {
  const obs = new MutationObserver(() => {})
  obs.observe(container, { subtree: true, childList: true, attributes: true, characterData: true })
  act(action)
  const rows = new Set<string>()
  for (const r of obs.takeRecords()) {
    const node = r.target.nodeType === Node.ELEMENT_NODE ? (r.target as Element) : r.target.parentElement
    const id = node?.closest('[data-block-id]')?.getAttribute('data-block-id')
    if (id) rows.add(id)
  }
  obs.disconnect()
  return rows
}

describe('полотно не перерисовывается целиком на правку одного блока (TD-32)', () => {
  it('набор в подпись трогает только свою строку', () => {
    const { store, container } = mount(12)
    // Прогреваем: первый рендер трогает всё по определению, мерить надо ПРАВКУ.
    touchedRows(container, () => {
      store.getState().updateBlock('c5', { text: textFromString('Вопрос 5.') })
    })

    const touched = touchedRows(container, () => {
      store.getState().updateBlock('c5', { text: textFromString('Вопрос 5..') })
    })

    expect([...touched]).toEqual(['c5'])
  })

  it('цена правки не растёт с размером формы', () => {
    // Тот же жест на форме вчетверо больше обязан стоить столько же: линейный рост —
    // это и есть дефект (≈5 мс + 0.13 мс на каждый блок формы на каждый символ).
    const small = mount(6)
    touchedRows(small.container, () => {
      small.store.getState().updateBlock('c2', { text: textFromString('a') })
    })
    const smallTouched = touchedRows(small.container, () => {
      small.store.getState().updateBlock('c2', { text: textFromString('ab') })
    })
    cleanup()

    const big = mount(48)
    touchedRows(big.container, () => {
      big.store.getState().updateBlock('c2', { text: textFromString('a') })
    })
    const bigTouched = touchedRows(big.container, () => {
      big.store.getState().updateBlock('c2', { text: textFromString('ab') })
    })

    expect(bigTouched.size).toBe(smallTouched.size)
  })
})
