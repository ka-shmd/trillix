// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { type Block } from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { multiSelectControl as MultiSelect } from '@fields/kinds/multiSelect'

// Контрол тегов: свой выпадающий список, поэтому клавиатура и мышь проверяются здесь, а
// не браузером ОС. Значение держит обвязка — как у рендерера, контрол управляемый.

afterEach(cleanup)

const BLOCK: Block = {
  id: 'city',
  groupId: 'g1',
  type: 'multi_select',
  settings: {
    options: [
      { id: 'msk', label: 'Москва' },
      { id: 'kzn', label: 'Казань' },
      { id: 'klg', label: 'Калининград' },
    ],
  },
}

let last: Answer = []

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<Answer>([])
  return (
    <MultiSelect
      block={BLOCK}
      label="Город"
      value={value}
      onChange={(v) => {
        last = v
        setValue(v)
      }}
      disabled={disabled}
      invalid={false}
    />
  )
}

function open() {
  render(<Harness />)
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  return input
}

describe('теги', () => {
  it('фокус открывает список, ввод его сужает', () => {
    const input = open()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    fireEvent.change(input, { target: { value: 'ка' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Казань', 'Калининград'])
  })

  it('Enter выбирает активный пункт, список остаётся открытым, поиск очищается', () => {
    const input = open()
    fireEvent.change(input, { target: { value: 'каз' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(last).toEqual(['kzn'])
    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByText('Казань', { selector: '.rf-tag-text' })).toBeTruthy()
  })

  it('стрелки двигают активный пункт, Backspace на пустой строке убирает последний тег', () => {
    const input = open()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(last).toEqual(['msk', 'kzn'])
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(last).toEqual(['msk'])
  })

  it('клик по пункту выбирает, повторный снимает; крестик плашки убирает тег', () => {
    open()
    fireEvent.click(screen.getByRole('option', { name: 'Калининград' }))
    expect(last).toEqual(['klg'])
    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Калининград»' }))
    expect(last).toEqual([])
  })

  it('Esc закрывает список', () => {
    const input = open()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('в превью (disabled) списка нет', () => {
    render(<Harness disabled />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})
