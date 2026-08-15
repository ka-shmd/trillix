// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SCHEMA_VERSION, type FormSchema } from '@entities/formSchema'

import { CoverRow, LogoRow } from './DesignChrome'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'

// КНОПКИ ХРОМА В ПАНЕЛИ ОБЯЗАНЫ БЫТЬ ЖИВЫМИ. Первая редакция строк рисовала кнопку
// собственным компонентом, который не раскладывал на <button> пропсы, приходящие от
// PopoverTrigger asChild, — заполненный логотип и обложка выглядели кнопками и не
// нажимались (найдено владельцем на живой проверке 2026-08-16).
//
// Сторож проверяет ИМЕННО ЭТО: у кнопки под триггером стоят его атрибуты
// (`aria-haspopup`, `aria-expanded`, `data-state`) — они есть только тогда, когда
// пропсы дошли до DOM-узла. Само открытие поповера не проверяется: Radix в happy-dom
// не разворачивается (STATUS.md), и красного без этой проверки не было бы нигде.

afterEach(cleanup)

function setup(schema: Partial<FormSchema>) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks: [], ...schema } as FormSchema)
  return (ui: React.ReactNode) => (
    <BuilderStoreContext.Provider value={store}>{ui}</BuilderStoreContext.Provider>
  )
}

describe('кнопки хрома в панели оформления', () => {
  it('заполненный логотип открывает меню, а не молчит', () => {
    const wrap = setup({ logo: { imageKey: 'ws/logo.png' } })
    render(wrap(<LogoRow formId="f1" />))
    const button = screen.getByRole('button', { name: 'Логотип' })
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('data-state')).toBe('closed')
  })

  it('обложка нажимается и пустой, и заполненной', () => {
    for (const [name, schema] of [
      ['Добавить обложку', {}],
      ['Обложка', { cover: { color: '#ff8800' } }],
    ] as const) {
      const wrap = setup(schema)
      const { unmount } = render(wrap(<CoverRow formId="f1" />))
      const button = screen.getByRole('button', { name })
      expect(button.getAttribute('aria-haspopup')).toBe('dialog')
      unmount()
    }
  })

  // Размеры настраивают существующую картинку: без неё числам не во что уехать —
  // схема хранит их внутри объекта логотипа и обложки.
  it('числа выключены, пока картинки нет, и включены, когда она есть', () => {
    const empty = setup({})
    const { unmount } = render(empty(<LogoRow formId="f1" />))
    expect((screen.getByLabelText('Ширина') as HTMLInputElement).disabled).toBe(true)
    unmount()

    const filled = setup({ logo: { imageKey: 'ws/logo.png', width: 140 } })
    render(filled(<LogoRow formId="f1" />))
    const width = screen.getByLabelText('Ширина') as HTMLInputElement
    expect(width.disabled).toBe(false)
    expect(width.value).toBe('140')
  })
})
