// @vitest-environment happy-dom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { type Availability } from '../../entities/schedule'
import { WeekEditor } from './WeekEditor'

afterEach(cleanup)

// Обёртка со своим состоянием: WeekEditor управляемый, и без неё ни один клик не
// доехал бы до разметки — проверялся бы вызов onChange, а не то, что видит автор.
function Harness({ initial }: { initial: Availability }) {
  const [value, setValue] = useState(initial)
  return <WeekEditor value={value} onChange={setValue} />
}

const workday: Availability = {
  weekly: { mon: [{ from: '10:00', to: '18:00' }] },
  exceptions: [],
}

// Строка дня ищется по подписи тумблера: заголовков у строк нет, и цепляться за
// порядок в разметке значило бы ловить перестановку дней как поломку теста.
//
// Состояние тумблера читается aria-атрибутом, а не матчером toBeChecked:
// jest-dom в проекте нет, а заводить его ради одного теста — новая зависимость.
function dayOn(title: string): boolean {
  return screen.getByRole('switch', { name: title }).getAttribute('aria-checked') === 'true'
}

function dayRow(title: string): HTMLElement {
  return screen.getByRole('group', { name: title })
}

describe('приём по дням недели', () => {
  it('день с окнами включён, пустой — выключен и говорит об этом', () => {
    render(<Harness initial={workday} />)

    expect(dayOn('Понедельник')).toBe(true)
    expect(dayOn('Суббота')).toBe(false)
    expect(within(dayRow('Суббота')).getByText('Не принимаю')).toBeTruthy()
  })

  it('включение дня даёт рабочее окно, а не пустую строку', () => {
    render(<Harness initial={workday} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Суббота' }))

    const row = dayRow('Суббота')
    expect(within(row).queryByText('Не принимаю')).toBeNull()
    expect(within(row).getByText('10:00')).toBeTruthy()
    expect(within(row).getByText('18:00')).toBeTruthy()
  })

  it('«Окно» добавляет второе окно — так задаётся перерыв', () => {
    render(<Harness initial={workday} />)

    fireEvent.click(within(dayRow('Понедельник')).getByRole('button', { name: 'Окно' }))

    expect(within(dayRow('Понедельник')).getAllByRole('button', { name: 'Убрать окно' })).toHaveLength(2)
  })

  it('«На все будни» повторяет окна дня на пн–пт и не трогает выходные', () => {
    render(<Harness initial={workday} />)

    fireEvent.click(within(dayRow('Понедельник')).getByRole('button', { name: 'На все будни' }))

    for (const day of ['Вторник', 'Среда', 'Четверг', 'Пятница']) {
      expect(dayOn(day)).toBe(true)
      expect(within(dayRow(day)).getByText('10:00')).toBeTruthy()
    }
    expect(dayOn('Суббота')).toBe(false)
  })

  it('убрать последнее окно можно: день без окон и есть выключенный день', () => {
    render(<Harness initial={workday} />)

    fireEvent.click(within(dayRow('Понедельник')).getByRole('button', { name: 'Убрать окно' }))

    expect(dayOn('Понедельник')).toBe(false)
    expect(within(dayRow('Понедельник')).getByText('Не принимаю')).toBeTruthy()
  })

  it('вывернутые окна краснеют под строкой, а не молчат до сохранения', () => {
    render(
      <Harness
        initial={{
          weekly: {
            mon: [
              { from: '14:00', to: '18:00' },
              { from: '10:00', to: '13:00' },
            ],
          },
          exceptions: [],
        }}
      />,
    )

    const alerts = screen.getAllByRole('alert')
    expect(alerts.map((a) => a.textContent)).toContain('Окна пересекаются или идут не по порядку')
  })
})
