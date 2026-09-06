// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { Block } from '@entities/formSchema'
import { SlotStubProvider } from '@fields/booking'
import { BlockField } from '@fields/BlockField'
import { SlotStub } from '@fields/slots/SlotStub'

// ЗАГЛУШКА ВИДА ЗАПИСИ (решение владельца 2026-09-06). Полотно редактора и превью
// показывают вопрос таким, каким он приедет к респонденту, хотя живого свободного
// времени в кабинете нет. Тест живёт в кабинете: у web/shared своего vitest нет.

afterEach(cleanup)

const slotBlock: Block = { id: 'b1', groupId: 'g1', type: 'slot' }

describe('заглушка вида записи', () => {
  it('показывает ленту дат и сетку времён', () => {
    const { container } = render(<SlotStub />)

    expect(container.querySelectorAll('.rf-slots-date').length).toBeGreaterThanOrEqual(7)
    expect(container.querySelectorAll('.rf-slots-time').length).toBeGreaterThan(0)
    expect(container.querySelector('.rf-slots-month')?.textContent).toBeTruthy()
  })

  it('не содержит ни одного фокусируемого элемента', () => {
    // МИНА. Строка записи на полотне — ОБЪЕКТ: каретка встаёт на неё саму, кольцом.
    // Кнопка внутри увела бы у полотна Tab, и клавиатурный поток строки сломался бы
    // молча — `disabled` снимает клик, но не фокус.
    const { container } = render(<SlotStub />)

    expect(container.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0)
  })

  it('лента начинается с сегодняшнего дня', () => {
    const { container } = render(<SlotStub />)

    const first = container.querySelector('.rf-slots-date .rf-slots-num')
    expect(first?.textContent).toBe(String(new Date().getDate()))
  })
})

describe('где заглушка появляется, а где нет', () => {
  it('превью рисует её вместо плашки', () => {
    const { container } = render(
      <SlotStubProvider value={SlotStub}>
        <BlockField block={slotBlock} disabled={false} />
      </SlotStubProvider>,
    )

    expect(container.querySelector('.rf-slots-week')).toBeTruthy()
  })

  it('печатный лист остаётся с плашкой, даже когда заглушка объявлена', () => {
    // Читаемый режим показывает ОТВЕТ, а не приглашение выбрать: сетка времён на
    // бумаге — это ложь о том, что человек мог бы выбрать месяц назад.
    const { container } = render(
      <SlotStubProvider value={SlotStub}>
        <BlockField block={slotBlock} value="2026-09-10T08:00:00Z" disabled readOnly />
      </SlotStubProvider>,
    )

    expect(container.querySelector('.rf-slots-week')).toBeNull()
    expect(container.querySelector('.rf-slot-value')?.textContent).toBeTruthy()
  })

  it('форма без расписания оставляет респонденту плашку, а не заглушку', () => {
    // В рендерере заглушки нет вовсе (её никто не кладёт в контекст), и это не
    // случайность: вопрос без расписания обязан честно ничего не предлагать.
    const { container } = render(<BlockField block={slotBlock} disabled={false} />)

    expect(container.querySelector('.rf-slots-week')).toBeNull()
    expect(container.querySelector('.rf-slot-empty')).toBeTruthy()
  })
})
