// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { type Block, type LogicCondition } from '@entities/formSchema'

import { ConditionEditor, JoinSelect } from './ConditionEditor'
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
  const joinOf = (value: Group) => {
    render(<JoinSelect value={value} onChange={vi.fn()} />)
    return join()
  }

  it('у одного условия не показывается — связывать нечего', () => {
    expect(joinOf({ all: [leaf('a')] })).toBeNull()
  })

  it('у двух условий показывается', () => {
    expect(joinOf({ all: [leaf('a'), leaf('b')] })).toBeTruthy()
  })

  it('у пустого условия не показывается', () => {
    expect(joinOf({ all: [] })).toBeNull()
  })

  // Связку КОРНЯ рисует ярус «Когда» — она стоит в одной строке с его подписью, а не
  // над первым условием.
  it('корень своей связки не рисует — её ставит ярус', () => {
    setup({ all: [leaf('a'), leaf('b')] })
    expect(join()).toBeNull()
  })

  it('вложенная группа связку рисует сама — своей подписи у неё нет', () => {
    setup({ all: [leaf('a'), { any: [leaf('a'), leaf('b')] }] })
    expect(screen.queryAllByLabelText('Как объединять условия')).toHaveLength(1)
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

  // Три контрола стоят ВСЕГДА (решение владельца 2026-08-16): строка не должна
  // перестраиваться под курсором, пока автор её заполняет.
  it('у незаполненной строки все три контрола на месте, но выключены', () => {
    setup({ all: [] })
    // jest-dom не подключён (его нет в замороженном списке), поэтому смотрим атрибут:
    // Radix ставит disabled на кнопку-триггер, Input — на нативный input.
    expect(screen.getByLabelText('Сравнение').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Значение').hasAttribute('disabled')).toBe(true)
    // Второе условие добавляется, пока первое ещё не выбрано.
    expect(actions()).toHaveLength(1)
  })
})

// Список источников из happy-dom не виден (Radix его не раскрывает), но ВЫБРАННЫЙ пункт
// виден: Radix телепортирует его содержимое в слот значения триггера. Значит и глиф в
// контроле проверяется отсюда — а он там же и ломается, если у слота отнять флекс.
describe('глиф вопроса-источника', () => {
  const glyphOf = (type: Block['type']): string | null => {
    const blocks = [{ id: 'a', groupId: 'g_a', type }]
    render(
      <ConditionEditor
        blocks={blocks}
        sources={blocks}
        value={{ all: [leaf('a')] }}
        onChange={vi.fn()}
      />,
    )
    const svg = screen.getByLabelText('Вопрос-источник').querySelector('[data-slot=select-value] svg')
    return svg?.getAttribute('class') ?? null
  }

  it('в контроле стоит глиф типа вопроса, а не только имя', () => {
    expect(glyphOf('date')).toContain('lucide-calendar')
    expect(screen.getByText('Дата 1')).toBeTruthy()
  })

  it('глиф идёт от ТИПА — у другого вопроса он другой', () => {
    expect(glyphOf('short_text')).toContain('lucide-case-sensitive')
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

  it('вложенная группа получает ТО ЖЕ меню — она такой же ребёнок', () => {
    setup({ all: [leaf('a'), { any: [leaf('a'), leaf('b')] }] })
    // Одно у листа снаружи, одно у самой группы, два у её строк.
    expect(actions()).toHaveLength(4)
  })

  it('у группы из ОДНОГО условия связки нет, а меню есть', () => {
    setup({ all: [leaf('a'), { any: [leaf('b')] }] })
    expect(screen.queryAllByLabelText('Как объединять условия')).toHaveLength(0)
    // Меню: лист снаружи, сама группа, её единственная строка.
    expect(actions()).toHaveLength(3)
  })
})
