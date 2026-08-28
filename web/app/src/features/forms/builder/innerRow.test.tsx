// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { type FormSchema, SCHEMA_VERSION, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { PreviewPane } from './PreviewPane'

// Ряд ВНУТРИ вопроса (фаза 15, спека §6.7): подпись и поле встают бок о бок той же
// обёрткой .rf-row и теми же ячейками .rf-cell, что ряд вариантов и ряд из двух
// вопросов. Структура — контракт вида: её надевают три поверхности, и разъедься они
// здесь, ряд поехал бы на одной из них. Проверяется превью (общий с рендерером
// раскладчик packGroupRows и общий fields.css); попиксельное совпадение редактора с
// превью — замер getComputedStyle в e2e, юниту он недоступен.

afterEach(cleanup)

const schema = (...blocks: FormSchema['blocks']): FormSchema => ({
  schemaVersion: SCHEMA_VERSION,
  blocks,
})

const caption = (id: string, groupId: string, right = false) => ({
  id,
  groupId,
  type: 'title' as const,
  text: textFromString('Индекс'),
  ...(right ? { settings: { column: 2 as const } } : {}),
})

const field = (
  id: string,
  groupId: string,
  right = false,
  type: 'short_text' | 'long_text' = 'short_text',
) => ({
  id,
  groupId,
  type,
  ...(right ? { settings: { column: 2 as const } } : {}),
})

function preview(s: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(s)
  render(
    <BuilderStoreContext.Provider value={store}>
      <PreviewPane title="Анкета" badge={false} />
    </BuilderStoreContext.Provider>,
  )
  return document.querySelector('.rf-form')!
}

describe('ряд внутри вопроса в превью', () => {
  it('пара «подпись + поле» — .rf-group > .rf-row с двумя ячейками', () => {
    const form = preview(schema(caption('t', 'g'), field('f', 'g', true)))

    const group = form.querySelector(':scope > .rf-group')!
    const rows = group.querySelectorAll(':scope > .rf-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.querySelectorAll(':scope > .rf-cell')).toHaveLength(2)
  })

  it('вопрос без бита — блоки прямыми детьми группы, в ряд не заворачиваются', () => {
    const form = preview(schema(caption('t', 'g'), field('f', 'g')))

    const group = form.querySelector(':scope > .rf-group')!
    expect(group.querySelectorAll(':scope > .rf-row')).toHaveLength(0)
    expect(group.children).toHaveLength(2)
  })

  // §6.5: группа с внутренним рядом занимает всю ширину. Проверяем не CSS, а то, что
  // раскладчик не собрал кросс-групповой ряд: обёртки .rf-row прямо в .rf-form нет.
  it('вопрос с внутренним рядом в ряд с соседним вопросом не встаёт', () => {
    const form = preview(schema(field('a', 'ga'), caption('t', 'gb', true), field('f', 'gb', true)))

    expect(form.querySelectorAll(':scope > .rf-row')).toHaveLength(0)
    expect(form.querySelectorAll(':scope > .rf-group')).toHaveLength(2)
  })
})

// ДВУХКОЛОНОЧНАЯ СЕКЦИЯ (§11): в каждой колонке сколько угодно элементов. Разметка та
// же, что у пары и у стопки — .rf-row → .rf-cell → группы; отличается только число
// групп в ячейке. Проверяем превью (общий с рендерером раскладчик и общий fields.css).
describe('двухколоночная секция в превью', () => {
  const col = (id: string, column: number) => ({
    id,
    groupId: id,
    type: 'short_text' as const,
    settings: { column },
  })

  it('три элемента слева и два справа — две ячейки, 3 и 2 группы', () => {
    const form = preview(
      schema(col('l1', 1), col('l2', 1), col('l3', 1), col('r1', 2), col('r2', 2)),
    )

    const rows = form.querySelectorAll(':scope > .rf-row')
    expect(rows).toHaveLength(1)
    const cells = rows[0]!.querySelectorAll(':scope > .rf-cell')
    expect(cells).toHaveLength(2)
    expect(cells[0]!.querySelectorAll(':scope > .rf-group')).toHaveLength(3)
    expect(cells[1]!.querySelectorAll(':scope > .rf-group')).toHaveLength(2)
  })

  it('четыре колонки — потолок ряда: четыре ячейки, в каждой своя группа', () => {
    // Колонок стало до MAX_COLUMNS (2026-08-11): раскладчик тот же, номер колонки — тот
    // же ключ, и превью обязано показать ровно столько ячеек, сколько номеров в
    // документе.
    const form = preview(schema(col('c1', 1), col('c2', 2), col('c3', 3), col('c4', 4)))

    const cells = form.querySelectorAll(':scope > .rf-row > .rf-cell')
    expect(cells).toHaveLength(4)
    for (const cell of cells) expect(cell.querySelectorAll(':scope > .rf-group')).toHaveLength(1)
  })

  it('блок без бита под секцией — прямой ребёнок .rf-form, во всю ширину', () => {
    const form = preview(schema(col('l1', 1), col('r1', 2), field('f', 'gf')))

    expect(form.querySelectorAll(':scope > .rf-row')).toHaveLength(1)
    // Полноширинный блок в ряд не заворачивается вовсе — он прямой ребёнок формы.
    expect(form.querySelectorAll(':scope > .rf-group')).toHaveLength(1)
  })
})

// Стопка в колонке ряда (§5, решение владельца 2026-07-29): при длинном блоке слева
// справа встаёт несколько коротких — друг под другом, в ОДНОЙ ячейке. Разметка та же,
// что у пары: .rf-row → .rf-cell → группы; глубину задаёт число групп в ячейке.
describe('стопка в колонке ряда', () => {
  it('три участника — две ячейки: одна группа слева, две справа', () => {
    const form = preview(
      schema(field('a', 'ga', false, 'long_text'), field('b', 'gb', true), field('c', 'gc', true)),
    )

    const rows = form.querySelectorAll(':scope > .rf-row')
    expect(rows).toHaveLength(1)
    const cells = rows[0]!.querySelectorAll(':scope > .rf-cell')
    expect(cells).toHaveLength(2)
    expect(cells[0]!.querySelectorAll(':scope > .rf-group')).toHaveLength(1)
    expect(cells[1]!.querySelectorAll(':scope > .rf-group')).toHaveLength(2)
  })
})
