// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { textFromString, type Block } from '@entities/formSchema'

import { answerColumns } from './columns'
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SubmissionsTable
        rows={ROWS}
        columns={answerColumns(BLOCKS)}
        files={{}}
        showVersion={false}
        formId="f1"
        onOpen={onOpen}
      />
    </QueryClientProvider>,
  )
  return onOpen
}

describe('таблица ответов', () => {
  it('колонка на вопрос, строка на ответ', () => {
    renderTable()
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Заполнен', 'Как вы о нас узнали', 'Оценка', 'Действия'])
    // Строк ровно столько, сколько ответов, плюс шапка.
    expect(screen.getAllByRole('row')).toHaveLength(ROWS.length + 1)
  })

  it('в ячейке стоит подпись варианта, а не его id', () => {
    // Тот же резолв, что в выгрузке: id опции владельцу ничего не говорит.
    renderTable()
    expect(screen.getAllByText('Реклама')).toHaveLength(ROWS.length)
  })

  it('на неотвеченный вопрос ставит прочерк, а не пустоту', () => {
    // Пустая клетка неотличима от недогрузившейся строки.
    renderTable()
    const rows = screen.getAllByRole('row')
    expect(within(rows[2]!).getByText('—')).toBeTruthy()
  })

  it('клик по строке открывает ответ', () => {
    const onOpen = renderTable()
    fireEvent.click(screen.getAllByRole('row')[1]!)
    expect(onOpen).toHaveBeenCalledWith(ROWS[0])
  })

  it('клик по «⋯» ответ НЕ открывает', () => {
    // Клик по триггеру всплывает до строки, если его не остановить, и меню
    // открывается одновременно с окном ответа поверх него.
    const onOpen = renderTable()
    fireEvent.click(screen.getAllByRole('button', { name: /Действия с ответом/ })[0]!)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
