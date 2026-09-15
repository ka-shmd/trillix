// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DialogBody } from './BlockTypeDialog'
import { editorKind } from './kinds/index'
import { type MenuItem } from './blockTypes'

// Окно «+» собрано на Command ради клавиатуры: стрелки из поля поиска двигают выбор,
// Enter вставляет выбранный тип. Сторожится ровно граница с cmdk — Enter обязан
// вставить ОДИН раз и именно показанный в превью тип, а наведение выбор не двигает.

afterEach(cleanup)

function setup() {
  const onPick = vi.fn<(item: MenuItem) => void>()
  render(<DialogBody onPick={onPick} />)
  const search = screen.getByRole('combobox', { name: 'Поиск по названию' })
  return { onPick, search }
}

describe('окно выбора типа блока', () => {
  it('стрелка вниз из поиска выбирает следующий тип, Enter его вставляет', () => {
    const { onPick, search } = setup()
    const options = screen.getAllByRole('option')
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(search, { key: 'ArrowDown', code: 'ArrowDown' })
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]![0].label).toBe(options[1]!.textContent)
  })

  // Пример обязан показывать то, что приедет на полотно (набор блоков как у вставки).
  const pick = (label: string, nth = 0) => {
    const option = screen.getAllByRole('option').filter((o) => o.textContent === label)[nth]
    fireEvent.click(option!)
  }

  it('пример вопроса — с подписью, без звёздочки обязательности', () => {
    setup()
    pick(editorKind('short_text').label)
    expect(document.querySelector('.rf-label')?.textContent).toContain('Ваш вопрос')
    expect(document.querySelector('.rf-required')).toBeNull()
    // Согласие рисует звёздочку своим контролом, по required блока.
    pick(editorKind('consent').label)
    expect(document.querySelector('.rf-consent')).not.toBeNull()
    expect(document.querySelector('.rf-required')).toBeNull()
  })

  it('голое поле типа, которому нужна подпись, показывается с подписью', () => {
    setup()
    // Второе вхождение — пункт раздела «Отдельные поля».
    pick(editorKind('scale').label, 1)
    expect(document.querySelector('.rf-label')).not.toBeNull()
    pick(editorKind('short_text').label, 1)
    expect(document.querySelector('.rf-label')).toBeNull()
  })

  it('у блоков, невидимых респонденту, примера нет', () => {
    setup()
    pick(editorKind('page_break').label)
    expect(screen.queryByText('Пример')).toBeNull()
    pick(editorKind('logic').label)
    expect(screen.queryByText('Пример')).toBeNull()
  })

  it('клик выбирает тип для превью, но не вставляет', () => {
    const { onPick } = setup()
    const options = screen.getAllByRole('option')
    fireEvent.click(options[2]!)
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(options[2]!.textContent)
  })
})
