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

const choice = (...options: { id: string; label: string; column?: 'right' }[]): Block => ({
  id: 'ch',
  groupId: 'g1',
  type: 'multi_choice',
  settings: { options },
})

const list = () => document.querySelector('.rf-options')!

describe('ряды вариантов в @fields/BlockField', () => {
  it('ряд из двоих — .rf-row с двумя ячейками, в каждой по карточке', () => {
    render(<BlockField block={choice({ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет', column: 'right' })} />)

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
          { id: 'o2', label: 'B-вариант', column: 'right' },
          { id: 'o3', label: 'C-вариант' },
        )}
      />,
    )

    const labels = [...list().querySelectorAll('.rf-option')].map((el) => el.textContent)
    expect(labels).toEqual(['AA-вариант', 'BB-вариант', 'CC-вариант'])
  })
})
