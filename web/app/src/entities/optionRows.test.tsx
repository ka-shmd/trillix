// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { Block } from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'

// Ряд вариантов — 50/50 ЯЧЕЙКИ (фаза 13.6, спека §5.1). Карточка обнимает текст, но
// правый вариант обязан начинаться с середины колонки, а не сразу за левым: иначе его
// позиция зависела бы от длины левой подписи (владелец: «переносятся в рандомное место»).
// Структуру держит .rf-cell в fields.css, и её надевают все три поверхности — здесь
// проверяется общая (@fields/BlockField, её видят рендерер и превью). Тест живёт в
// кабинете: у web/shared своего vitest нет.

afterEach(cleanup)

// Одиночный выбор: у него карточки с буквенным бейджем, и в текстовом содержимом
// карточки видно и букву, и подпись. У множественного бейджей нет вовсе (обычные
// чекбоксы, 2026-07-26) — раскладку рядов это не меняет, её проверяют те же тесты.
const choice = (...options: { id: string; label: string; column?: number }[]): Block => ({
  id: 'ch',
  groupId: 'g1',
  type: 'single_choice',
  settings: { options },
})

const list = () => document.querySelector('.rf-options')!

describe('ряды вариантов в @fields/BlockField', () => {
  it('ряд из двоих — .rf-row с двумя ячейками, в каждой по карточке', () => {
    render(<BlockField block={choice({ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет', column: 2 })} />)

    const rows = list().querySelectorAll(':scope > .rf-row')
    expect(rows).toHaveLength(1)
    const cells = rows[0]!.querySelectorAll(':scope > .rf-cell')
    expect(cells).toHaveLength(2)
    for (const cell of cells) expect(cell.querySelectorAll('.rf-option')).toHaveLength(1)
  })

  it('вариант без бита — прямой ребёнок списка, в ячейку не заворачивается', () => {
    render(<BlockField block={choice({ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет' })} />)

    expect(list().querySelectorAll(':scope > .rf-row')).toHaveLength(0)
    expect(list().querySelectorAll(':scope > .rf-option')).toHaveLength(2)
  })

  it('порядок документа не меняется, буквенные бейджи считаются по полному списку', () => {
    render(
      <BlockField
        block={choice(
          { id: 'o1', label: 'A-вариант' },
          { id: 'o2', label: 'B-вариант', column: 2 },
          { id: 'o3', label: 'C-вариант' },
        )}
      />,
    )

    const labels = [...list().querySelectorAll('.rf-option')].map((el) => el.textContent)
    expect(labels).toEqual(['AA-вариант', 'BB-вариант', 'CC-вариант'])
  })
})

// «Несколько из списка» — обычные чекбоксы (решение владельца 2026-07-26): глиф
// видимый, карточки и буквенного бейджа нет. «Один из списка» остаётся карточкой
// с буквой и спрятанным radio — разницу между типами должно быть видно сразу.
describe('вид вариантов по типу', () => {
  const withType = (type: 'single_choice' | 'multi_choice'): Block => ({
    id: 'ch',
    groupId: 'g1',
    type,
    settings: { options: [{ id: 'o1', label: 'Да' }] },
  })

  it('множественный выбор: видимый чекбокс, без карточки и без буквы', () => {
    render(<BlockField block={withType('multi_choice')} />)

    const option = list().querySelector('.rf-option')!
    expect(option.classList.contains('rf-option--check')).toBe(true)
    expect(option.querySelector('.rf-option-key')).toBeNull()
    const input = option.querySelector('input')!
    expect(input.getAttribute('type')).toBe('checkbox')
    expect(input.className).toContain('rf-mark') // виден, а не спрятан
  })

  it('одиночный выбор: карточка с буквой и спрятанный radio', () => {
    render(<BlockField block={withType('single_choice')} />)

    const option = list().querySelector('.rf-option')!
    expect(option.classList.contains('rf-option--check')).toBe(false)
    expect(option.querySelector('.rf-option-key')?.textContent).toBe('A')
    expect(option.querySelector('input')!.className).toContain('rf-choice-input')
  })
})
