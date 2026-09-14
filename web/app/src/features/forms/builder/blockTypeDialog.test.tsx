// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DialogBody } from './BlockTypeDialog'
import { Dialog } from '@/components/ui/dialog'
import { type MenuItem } from './blockTypes'

// Окно «+» собрано на Command ради клавиатуры: стрелки из поля поиска двигают выбор,
// Enter вставляет выбранный тип. Сторожится ровно граница с cmdk — Enter обязан
// вставить ОДИН раз и именно показанный в превью тип, а наведение выбор не двигает.

afterEach(cleanup)

function setup() {
  const onPick = vi.fn<(item: MenuItem) => void>()
  // Dialog — ради контекста крестика (DialogClose) в шапке тела окна.
  render(
    <Dialog open>
      <DialogBody onPick={onPick} />
    </Dialog>,
  )
  const search = screen.getByRole('textbox', { name: 'Поиск по названию' })
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

  it('клик выбирает тип для превью, но не вставляет', () => {
    const { onPick } = setup()
    const options = screen.getAllByRole('option')
    fireEvent.click(options[2]!)
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(options[2]!.textContent)
  })
})
