// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'

import { type FormSchema, SCHEMA_VERSION, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { PreviewPane } from './PreviewPane'
import { SlashEditor } from './SlashEditor'

// ДОЛИ КОЛОНОК (2026-08-22) на двух поверхностях кабинета. Правило действия проверено
// у раскладчика (groups.test.ts); здесь — что доля ДОЕХАЛА до разметки и что обе
// поверхности сошлись, потому что рисуют ряд разными боксами: превью настоящей
// .rf-cell с переменной --rf-cell-grow, полотно — своей ячейкой с flex-grow inline.
// Рендерер держит третью копию той же разметки, и его сторож — тот же раскладчик.

afterEach(cleanup)

const schema = (...blocks: FormSchema['blocks']): FormSchema => ({
  schemaVersion: SCHEMA_VERSION,
  blocks,
})

const wide = (id: string, column: number, columnWidth?: number) => ({
  id,
  groupId: id,
  type: 'short_text' as const,
  settings: { column, ...(columnWidth === undefined ? {} : { columnWidth }) },
})

function preview(s: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(s)
  render(
    <BuilderStoreContext.Provider value={store}>
      <PreviewPane title="Анкета" canRemoveBadge={false} />
    </BuilderStoreContext.Provider>,
  )
  return document.querySelector('.rf-form')!
}

function canvas(s: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(s)
  const engine = createFocusEngine()
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={qc}>
      <BuilderStoreContext.Provider value={store}>
        <FocusEngineProvider value={engine}>
          <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
        </FocusEngineProvider>
      </BuilderStoreContext.Provider>
    </QueryClientProvider>,
  )
  return container
}

// Доли ряда так, как их видит браузер: у превью — переменная, у полотна — flex-grow.
const previewGrow = (form: Element): string[] =>
  [...form.querySelectorAll(':scope > .rf-row > .rf-cell')].map(
    (c) => (c as HTMLElement).style.getPropertyValue('--rf-cell-grow'),
  )

const canvasGrow = (container: Element): string[] =>
  [...container.querySelectorAll('ol > div > div.self-start')].map(
    (c) => (c as HTMLElement).style.flexGrow,
  )

describe('доли колонок доезжают до разметки', () => {
  it('превью печатает переменную у каждой колонки', () => {
    const form = preview(schema(wide('a', 1, 70), wide('b', 2, 30)))
    expect(previewGrow(form)).toEqual(['70', '30'])
  })

  it('полотно печатает ту же долю своим flex-grow', () => {
    const container = canvas(schema(wide('a', 1, 70), wide('b', 2, 30)))
    expect(canvasGrow(container)).toEqual(['70', '30'])
  })

  it('доли не сходятся — обе поверхности делят ряд поровну', () => {
    const bad = schema(wide('a', 1, 70), wide('b', 2, 70))
    expect(previewGrow(preview(bad))).toEqual(['', ''])
    cleanup()
    expect(canvasGrow(canvas(bad))).toEqual(['', ''])
  })

  it('колонка без доли (её только что добавили) — ряд поровну целиком', () => {
    const fresh = schema(wide('a', 1, 70), wide('b', 2, 30), wide('c', 3))
    expect(previewGrow(preview(fresh))).toEqual(['', '', ''])
  })

  it('ряд внутри вопроса несёт свои доли', () => {
    const form = preview(
      schema(
        {
          id: 't',
          groupId: 'g',
          type: 'title',
          text: textFromString('Индекс'),
          settings: { column: 1, columnWidth: 35 },
        },
        { id: 'f', groupId: 'g', type: 'short_text', settings: { column: 2, columnWidth: 65 } },
      ),
    )
    const cells = form.querySelectorAll(':scope > .rf-group > .rf-row > .rf-cell')
    expect([...cells].map((c) => (c as HTMLElement).style.getPropertyValue('--rf-cell-grow'))).toEqual([
      '35',
      '65',
    ])
  })
})

// РУЧКА ЖЕСТА в разметке полотна: где она есть и где её нет. Само перетаскивание в
// vitest не воспроизводится — его арифметика проверена в columnResize.test.ts.
describe('ручка ширины на полотне', () => {
  const handles = (container: Element) => container.querySelectorAll('[data-rf-resizer]')

  it('у ряда из двух колонок ручка одна — на их границе', () => {
    const container = canvas(schema(wide('a', 1), wide('b', 2)))
    expect(handles(container)).toHaveLength(1)
  })

  it('у ряда из четырёх колонок ручек три: границ на одну меньше, чем колонок', () => {
    const container = canvas(schema(wide('a', 1), wide('b', 2), wide('c', 3), wide('d', 4)))
    expect(handles(container)).toHaveLength(3)
  })

  it('полноширинные вопросы ручек не имеют — делить нечего', () => {
    const container = canvas(
      schema(
        { id: 'a', groupId: 'a', type: 'short_text' },
        { id: 'b', groupId: 'b', type: 'email' },
      ),
    )
    expect(handles(container)).toHaveLength(0)
  })

  it('ряд внутри вопроса несёт свою ручку', () => {
    const container = canvas(
      schema(
        { id: 't', groupId: 'g', type: 'title', text: textFromString('Индекс') },
        { id: 'f', groupId: 'g', type: 'short_text', settings: { column: 2 } },
      ),
    )
    expect(handles(container)).toHaveLength(1)
  })
})
