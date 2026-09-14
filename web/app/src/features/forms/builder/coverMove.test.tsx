// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SCHEMA_VERSION, type FormSchema } from '@entities/formSchema'

import { CoverArea } from './CoverEditor'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'

// Математика жеста своя и проверена табличным тестом (coverDrag.test.ts); здесь она
// подменена, чтобы протяжка в happy-dom (где у картинки нет размеров) давала сдвиг.
vi.mock('./coverDrag', () => ({
  coverOverflowPx: () => 100,
  nextCoverY: (_start: number, _from: number, to: number) => to,
}))

// Режим положения: сдвиг копится черновиком и уходит в стор только по «Сохранить»;
// «Отменить» возвращает сохранённое положение и шага истории не оставляет.

beforeAll(() => {
  // happy-dom не реализует захват указателя.
  HTMLElement.prototype.setPointerCapture ??= () => {}
})

afterEach(cleanup)

function setup() {
  const store = createBuilderStore()
  store.getState().hydrate({
    schemaVersion: SCHEMA_VERSION,
    blocks: [],
    cover: { imageKey: 'ws/cover.png', y: 50 },
  } as FormSchema)
  const { container } = render(
    <BuilderStoreContext.Provider value={store}>
      <CoverArea formId="f1" />
    </BuilderStoreContext.Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Положение' }))
  const band = container.querySelector('.group\\/cover')!.firstElementChild!
  const drag = (to: number) => {
    fireEvent.pointerDown(band, { clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(band, { clientY: to, pointerId: 1 })
    fireEvent.pointerUp(band, { clientY: to, pointerId: 1 })
  }
  return { store, drag }
}

describe('положение обложки', () => {
  it('протяжка не пишет в стор, «Сохранить» сохраняет последний сдвиг одним шагом', () => {
    const { store, drag } = setup()
    const history = store.getState().past.length
    expect(screen.getByText('Перетащите картинку, чтобы изменить её положение')).toBeTruthy()

    drag(30)
    drag(72.346)
    expect(store.getState().cover?.y).toBe(50)

    // Сохраняется сотая процента, а не целое: округление до целого и было сдвигом
    // картинки после сохранения.
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(store.getState().cover?.y).toBe(72.35)
    expect(store.getState().past.length).toBe(history + 1)
    expect(screen.getByRole('button', { name: 'Положение' })).toBeTruthy()
    expect(screen.queryByText('Перетащите картинку, чтобы изменить её положение')).toBeNull()
  })

  it('«Отменить» выбрасывает черновик', () => {
    const { store, drag } = setup()
    const history = store.getState().past.length

    drag(72)
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(store.getState().cover?.y).toBe(50)
    expect(store.getState().past.length).toBe(history)
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()
  })
})
