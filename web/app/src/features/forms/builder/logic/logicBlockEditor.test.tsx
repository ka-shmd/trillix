// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { type Block, SCHEMA_VERSION, textFromString } from '@entities/formSchema'

import { createBuilderStore } from '../store'
import { BuilderStoreContext } from '../storeContext'
import { LogicBlockEditor } from './LogicBlockEditor'

// Ярус «Тогда» устроен ровно как ярус «Когда»: строка самодостаточна, кнопки «добавить»
// под списком нет, пустой список рисуется незаполненной строкой. Проверяется то, что
// решается разметкой, — раскрыть Radix-селект happy-dom не умеет.

afterEach(cleanup)

const doc = (logic: Block['logic']): Block[] => [
  { id: 't_src', groupId: 'g_src', type: 'title', text: textFromString('Источник') },
  { id: 'src', groupId: 'g_src', type: 'short_text' },
  { id: 'L', groupId: 'gL', type: 'logic', logic },
  { id: 't_dep', groupId: 'g_dep', type: 'title', text: textFromString('Зависимый') },
  { id: 'dep', groupId: 'g_dep', type: 'short_text' },
]

function setup(logic: Block['logic']) {
  const store = createBuilderStore()
  const blocks = doc(logic)
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  const block = store.getState().blocks.find((b) => b.id === 'L')!
  render(
    <BuilderStoreContext.Provider value={store}>
      <LogicBlockEditor block={block} />
    </BuilderStoreContext.Provider>,
  )
  return { store }
}

const rowMenus = () => screen.queryAllByLabelText('Действия со строкой')
const kinds = () => screen.queryAllByLabelText('Действие')

describe('ярус «Тогда»', () => {
  it('без действий рисуется одна строка с «Выберите действие»', () => {
    setup({ when: { blockId: 'src', op: 'answered' } })
    expect(kinds()).toHaveLength(1)
    expect(screen.getByText('Выберите действие')).toBeTruthy()
  })

  it('меню есть и у незаполненной строки — второе действие добавляется оттуда', () => {
    setup({ when: { blockId: 'src', op: 'answered' } })
    expect(rowMenus()).toHaveLength(1)
  })

  it('кнопки «+ Действие» под списком больше нет', () => {
    setup({
      when: { blockId: 'src', op: 'answered' },
      then: [{ kind: 'show', targets: ['t_dep'] }],
    })
    const labels = screen
      .queryAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter(Boolean)
    expect(labels).not.toContain('Действие')
  })

  it('крестика в конце строки больше нет — удаление уехало в меню', () => {
    setup({
      when: { blockId: 'src', op: 'answered' },
      then: [{ kind: 'show', targets: ['t_dep'] }],
    })
    expect(screen.queryByLabelText('Удалить действие')).toBeNull()
    expect(rowMenus()).toHaveLength(1)
  })

  it('меню стоит у каждого заполненного действия', () => {
    setup({
      when: { blockId: 'src', op: 'answered' },
      then: [{ kind: 'show', targets: ['t_dep'] }, { kind: 'block_submit' }],
    })
    expect(rowMenus()).toHaveLength(2)
  })

  it('«скрыть кнопку» цели не показывает — ей адресовать нечего', () => {
    setup({ when: { blockId: 'src', op: 'answered' }, then: [{ kind: 'block_submit' }] })
    expect(screen.queryByLabelText('Цели действия')).toBeNull()
  })

  // Список действий из happy-dom не виден (Radix его не раскрывает), но ВЫБРАННЫЙ пункт
  // виден: Radix телепортирует его содержимое в слот значения триггера. Значит и значок
  // действия проверяется отсюда — а он там же и ломается, если у слота отнять флекс.
  it('на контроле действия стоит его значок, а не только название', () => {
    setup({
      when: { blockId: 'src', op: 'answered' },
      then: [{ kind: 'hide', targets: ['t_dep'] }],
    })
    const svg = kinds()[0]!.querySelector('[data-slot=select-value] svg')
    expect(svg?.getAttribute('class')).toContain('lucide-eye-off')
    expect(screen.getByText('Скрыть')).toBeTruthy()
  })

  // Второй контрол стоит ВСЕГДА (решение владельца 2026-08-16): строка не должна
  // перестраиваться под курсором, пока автор её заполняет.
  it('у незаполненной строки пикер целей на месте, но выключен', () => {
    setup({ when: { blockId: 'src', op: 'answered' } })
    const picker = screen.getByLabelText('Цели действия')
    expect(picker.hasAttribute('disabled')).toBe(true)
  })
})
