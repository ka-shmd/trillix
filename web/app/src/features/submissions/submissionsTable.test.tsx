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

  it('каждую колонку подписывает глиф', () => {
    // У вопроса — тот же глиф, что на полотне: подпись обрезана одной строкой, и у двух
    // похоже названных колонок глиф часто единственное отличие, которое видно целиком.
    // У даты отправки глиф свой — она не вопрос.
    renderTable()
    const heads = screen.getAllByRole('columnheader')
    for (const h of heads) expect(h.querySelector('svg')).toBeTruthy()
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

  it('клик по строке открывает ответ', () => {
    const onOpen = renderTable()
    fireEvent.click(screen.getAllByRole('row')[1]!)
    expect(onOpen).toHaveBeenCalledWith(ROWS[0])
  })

  it('дата — кнопка, и открывает ответ РОВНО один раз', () => {
    // Путь к ответу с клавиатуры: клик по строке мышью её не заменяет. Клик по
    // самой кнопке всплыл бы до строки и открыл бы окно дважды.
    const onOpen = renderTable()
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(ROWS[0])
  })
})
