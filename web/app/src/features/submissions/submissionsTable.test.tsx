// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { textFromString, type Block } from '@entities/formSchema'

import { answerColumns, previewColumns } from './columns'
import { SubmissionsTable } from './SubmissionsTable'
import { type Submission } from '../../entities/submission'

afterEach(cleanup)

const BLOCKS = [
  { id: 'cap1', groupId: 'g1', type: 'label', text: textFromString('Как вы о нас узнали') },
  {
    id: 'src',
    groupId: 'g1',
    type: 'single_choice',
    settings: { options: [{ id: 'o1', label: 'Реклама' }] },
  },
  { id: 'cap2', groupId: 'g2', type: 'label', text: textFromString('Оценка') },
  { id: 'rate', groupId: 'g2', type: 'number' },
  { id: 'cap3', groupId: 'g3', type: 'label', text: textFromString('Комментарий') },
  { id: 'note', groupId: 'g3', type: 'long_text' },
] as unknown as Block[]

const ROWS: Submission[] = [
  {
    id: 's1',
    formVersion: 3,
    createdAt: '2026-08-26T09:00:00Z',
    answers: { src: 'o1', rate: '8' },
  },
  { id: 's2', formVersion: 3, createdAt: '2026-08-25T09:00:00Z', answers: { src: 'o1' } },
]

function renderTable(onOpen = vi.fn()) {
  render(
    <SubmissionsTable
      rows={ROWS}
      columns={previewColumns(answerColumns(BLOCKS))}
      files={{}}
      showVersion={false}
      formId="f1"
      onOpen={onOpen}
    />,
  )
  return onOpen
}

describe('таблица ответов', () => {
  it('показывает два первых вопроса, а не все', () => {
    // Колонка на каждый вопрос уводит таблицу в прокрутку вбок; ответ целиком
    // читается в окне по строке.
    renderTable()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Дата отправки',
      'Как вы о нас узнали',
      'Оценка',
    ])
    expect(screen.getAllByRole('row')).toHaveLength(ROWS.length + 1)
  })

  it('колонку вопроса подписывает глиф его типа, колонку даты — нет', () => {
    // Тот же глиф, что у вопроса на полотне: подпись обрезана одной строкой, и у двух
    // похоже названных колонок глиф часто единственное отличие, которое видно целиком.
    // Дата глифа не получает — он различает вопросы, а дата в таблице одна.
    renderTable()
    const heads = screen.getAllByRole('columnheader')
    expect(heads[0]!.querySelector('svg')).toBeNull()
    expect(heads[1]!.querySelector('svg')).toBeTruthy()
    expect(heads[2]!.querySelector('svg')).toBeTruthy()
  })

  it('в ячейке стоит подпись варианта, а не его id', () => {
    // Тот же резолв, что в выгрузке: id опции владельцу ничего не говорит.
    renderTable()
    expect(screen.getAllByText('Реклама')).toHaveLength(ROWS.length)
  })

  it('на неотвеченный вопрос ставит прочерк, а не пустоту', () => {
    // Пустая клетка неотличима от недогрузившейся строки.
    renderTable()
    expect(within(screen.getAllByRole('row')[2]!).getByText('—')).toBeTruthy()
  })

  it('строка сама по себе ответ не открывает', () => {
    // Действия строки — значки в колонке даты, а не клик по всей полосе: половина
    // ширины таблицы это текст ответа, который хочется выделить и скопировать.
    const onOpen = renderTable()
    fireEvent.click(screen.getAllByRole('row')[1]!)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('значок «открыть» открывает ответ своей строки', () => {
    const onOpen = renderTable()
    fireEvent.click(screen.getAllByRole('button', { name: /Открыть ответ от/ })[0]!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(ROWS[0])
  })

  it('у каждой строки есть значок удаления', () => {
    // Значки гаснут прозрачностью, а не display:none, — иначе они выпадают из порядка
    // табуляции, и до удаления не добраться с клавиатуры.
    renderTable()
    expect(screen.getAllByRole('button', { name: /Удалить ответ от/ })).toHaveLength(ROWS.length)
  })
})
