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

const optionNames = () => screen.queryAllByRole('option').map((o) => o.textContent)

describe('теги', () => {
  it('фокус открывает список, ввод его сужает', () => {
    const input = open()
    expect(optionNames()).toEqual(['Москва', 'Казань', 'Калининград'])
    fireEvent.change(input, { target: { value: 'ка' } })
    expect(optionNames()).toEqual(['Казань', 'Калининград'])
  })

  it('Enter добавляет активный пункт: он уходит из списка в поле, список открыт, поиск пуст', () => {
    const input = open()
    fireEvent.change(input, { target: { value: 'каз' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(last).toEqual(['kzn'])
    expect((input as HTMLInputElement).value).toBe('')
    expect(optionNames()).toEqual(['Москва', 'Калининград'])
    expect(screen.getByText('Казань', { selector: '.rf-tag-text' })).toBeTruthy()
  })

  it('стрелки двигают активный пункт, Backspace на пустой строке убирает последний тег', () => {
    const input = open()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(last).toEqual(['msk', 'klg'])
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(last).toEqual(['msk'])
  })

  it('клик по пункту добавляет, крестик плашки убирает и возвращает вариант в список', () => {
    open()
    fireEvent.click(screen.getByRole('option', { name: 'Калининград' }))
    expect(last).toEqual(['klg'])
    expect(optionNames()).toEqual(['Москва', 'Казань'])
    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Калининград»' }))
    expect(last).toEqual([])
    expect(optionNames()).toEqual(['Москва', 'Казань', 'Калининград'])
  })

  it('цвет плашки — по позиции варианта, одинаковый в поле и в списке', () => {
    open()
    const inList = screen.getByRole('option', { name: 'Казань' }).querySelector('.rf-tag')!
    expect(inList.className).toContain('rf-tag--c1')
    fireEvent.click(screen.getByRole('option', { name: 'Казань' }))
    const inField = screen.getByText('Казань', { selector: '.rf-tag-text' }).parentElement!
    expect(inField.className).toContain('rf-tag--c1')
  })

  it('когда выбрано всё, список так и говорит', () => {
    const input = open()
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('Все варианты выбраны')).toBeTruthy()
  })

  it('Esc закрывает список', () => {
    const input = open()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(optionNames()).toHaveLength(0)
  })

  it('в превью (disabled) списка нет, шеврон есть', () => {
    const { container } = render(<Harness disabled />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(optionNames()).toHaveLength(0)
    expect(container.querySelector('.rf-tags-chevron')).toBeTruthy()
  })
})
