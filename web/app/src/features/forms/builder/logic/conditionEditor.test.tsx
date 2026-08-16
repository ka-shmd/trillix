// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { type Block, type LogicCondition } from '@entities/formSchema'

import { ConditionEditor } from './ConditionEditor'
import { type Group } from './model'

// Что именно проверяется здесь, а не в браузере: Radix ни Select, ни DropdownMenu в
// happy-dom не РАСКРЫВАЕТ — списка пунктов отсюда не видно и не будет. Зато видно то,
// что решается разметкой: показана ли связка, есть ли строка у пустого условия, стоит
// ли значок действий там, где он должен стоять. Ровно эти три вещи и ломались бы молча.

afterEach(cleanup)

const src = (id: string): Block => ({ id, groupId: `g_${id}`, type: 'short_text' })
const sources = [src('a'), src('b')]

const leaf = (blockId: string): LogicCondition => ({ blockId, op: 'answered' })

function setup(value: Group) {
  const onChange = vi.fn()
  render(
    <ConditionEditor blocks={sources} sources={sources} value={value} onChange={onChange} />,
  )
  return { onChange }
}

const join = () => screen.queryByLabelText('Как объединять условия')
const actions = () => screen.queryAllByLabelText('Действия с условием')

describe('связка «все/любое»', () => {
  it('у одного условия не показывается — связывать нечего', () => {
    setup({ all: [leaf('a')] })
    expect(join()).toBeNull()
  })

  it('у двух условий показывается', () => {
    setup({ all: [leaf('a'), leaf('b')] })
    expect(join()).toBeTruthy()
  })

  it('у пустого условия не показывается', () => {
    setup({ all: [] })
    expect(join()).toBeNull()
  })
})

describe('пустое условие', () => {
  it('рисуется одной незаполненной строкой, а не кнопкой «добавить»', () => {
    setup({ all: [] })
    // Плейсхолдер источника — то, с чего автор начинает: выбрал вопрос, и условие
    // появилось в документе.
    expect(screen.getByText('Вопрос…')).toBeTruthy()
    expect(screen.queryByText('Условие')).toBeNull()
    expect(screen.queryByText('Группа')).toBeNull()
  })

  it('у незаполненной строки нет ни сравнения, ни значения, ни меню', () => {
    setup({ all: [] })
    expect(screen.queryByLabelText('Сравнение')).toBeNull()
    expect(screen.queryByLabelText('Значение')).toBeNull()
    expect(actions()).toHaveLength(0)
  })
})

describe('меню строки', () => {
  it('стоит у каждого заполненного условия', () => {
    setup({ all: [leaf('a'), leaf('b')] })
    expect(actions()).toHaveLength(2)
  })

  it('кнопок «+ Условие» и «+ Группа» под деревом больше нет', () => {
    setup({ all: [leaf('a')] })
    const labels = screen
      .queryAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter(Boolean)
    expect(labels).not.toContain('Условие')
    expect(labels).not.toContain('Группа')
  })

  it('крестика в конце строки больше нет — удаление уехало в меню', () => {
    setup({ all: [leaf('a')] })
    expect(screen.queryByLabelText('Удалить условие')).toBeNull()
    expect(actions()).toHaveLength(1)
  })

  it('во вложенной группе меню есть у каждой её строки', () => {
    setup({ all: [leaf('a'), { any: [leaf('a'), leaf('b')] }] })
    // Одно снаружи плюс два внутри группы.
    expect(actions()).toHaveLength(3)
    // Связок теперь две: внешняя (два ребёнка) и внутренняя (тоже два).
    expect(screen.queryAllByLabelText('Как объединять условия')).toHaveLength(2)
  })
})
