// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { CanvasPopover, type Anchor } from './CanvasPopover'
import type { Schedule } from '../../entities/schedule'
import type { Gesture } from './canvasEdit'

// ПРОТЯЖКА НИЧЕГО НЕ РЕШАЕТ ЗА АВТОРА. Полотно рисует приём и занятость одним и тем же
// движением мыши, и до правки оно выбирало приём само, спрашивая только про объём
// (отчёт владельца 2026-09-04). Проверяется здесь именно порядок: первый вопрос — что
// это за время, и до ответа на второй правка правила не уходит.

afterEach(cleanup)

const schedule = { timezone: 'Europe/Moscow' } as Schedule

const gesture: Extract<Gesture, { kind: 'create' }> = {
  kind: 'create',
  dates: ['2026-09-15'],
  window: { from: '10:00', to: '14:00' },
}

const drawn: Anchor = { kind: 'draw', x: 10, y: 20, gesture, step: 'what', scope: null }
const asked: Anchor = { ...drawn, kind: 'draw', gesture, step: 'scope', scope: null }

function renderWith(anchor: Anchor, handlers: Partial<Parameters<typeof CanvasPopover>[0]> = {}) {
  const noop = () => {}
  render(
    <CanvasPopover
      anchor={anchor}
      schedule={schedule}
      onClose={noop}
      onDrawStep={noop}
      onScope={noop}
      onCloseTime={noop}
      onRemoveWindow={noop}
      onRemoveBlock={noop}
      onOpenSubmission={noop}
      onCancelBooking={noop}
      {...handlers}
    />,
  )
}

describe('свежая протяжка', () => {
  it('сначала спрашивает, что это за время, и называет размеченное место', () => {
    renderWith(drawn)
    expect(screen.getByText('15 сентября, 10:00 — 14:00')).toBeTruthy()
    expect(screen.getByText('Что это за время?')).toBeTruthy()
    // Вопроса об объёме на первом шаге нет: два вопроса разом — это тот же выбор за
    // автора, только в две колонки.
    expect(screen.queryByText('Это правило действует')).toBeNull()
  })

  it('«приём» ведёт ко второму вопросу, а не правит правило', () => {
    const onDrawStep = vi.fn()
    const onScope = vi.fn()
    renderWith(drawn, { onDrawStep, onScope })
    fireEvent.click(screen.getByRole('button', { name: /Приём/ }))
    expect(onDrawStep).toHaveBeenCalledWith('scope')
    expect(onScope).not.toHaveBeenCalled()
  })

  it('«занято» закрывает время тем же жестом', () => {
    const onCloseTime = vi.fn()
    renderWith(drawn, { onCloseTime })
    fireEvent.click(screen.getByRole('button', { name: /Занято/ }))
    expect(onCloseTime).toHaveBeenCalledWith(gesture)
  })

  it('на втором шаге правило уходит только после выбора объёма', () => {
    const onScope = vi.fn()
    renderWith(asked, { onScope })
    expect(screen.getByText('Это правило действует')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Каждый вторник' }))
    expect(onScope).toHaveBeenCalledWith(gesture, 'weekly')
  })
})
