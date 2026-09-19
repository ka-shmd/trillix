// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { BreakdownList, type BreakdownRow } from './Breakdown'

afterEach(cleanup)

// Разбивки визитов — списки, а не кольца (фаза 30, редизайн). Ни ResizeObserver, ни
// ожидания анимации им не нужно: всё, что видит владелец, лежит в DOM сразу.

function rows(n: number): BreakdownRow[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `r${i}`,
    label: `Строка ${i + 1}`,
    visits: (n - i) * 10,
    submitted: n - i,
  }))
}

describe('BreakdownList', () => {
  it('называет визиты, долю и конверсию строки', () => {
    render(
      <BreakdownList
        label="Источник"
        rows={[
          { key: 'a', label: 'Прямые заходы', visits: 75, submitted: 30 },
          { key: 'b', label: 'vk.com', visits: 25, submitted: 5 },
        ]}
      />,
    )
    expect(screen.getByText('75 · 75 %')).toBeTruthy()
    expect(screen.getByText('25 · 25 %')).toBeTruthy()
    // Конверсия — своей колонкой с подписью: без неё «40 %» рядом с «75 %» не
    // отличить от доли. Подпись первой колонки называет, что в ней лежит.
    expect(screen.getByText('Источник')).toBeTruthy()
    expect(screen.getByText('Отправили')).toBeTruthy()
    expect(screen.getByText('40 %')).toBeTruthy()
  })

  // Ниже порога малых выборок конверсия — два числа, а не процент: «100 %» по двум
  // визитам владелец прочтёт закономерностью.
  it('малую выборку показывает числами', () => {
    render(<BreakdownList label="Источник" rows={[{ key: 'a', label: 'BeOS', visits: 2, submitted: 2 }]} />)
    expect(screen.getByText('2 из 2')).toBeTruthy()
  })

  // РЕГРЕССИЯ. В легенде кольца подпись обрезалась по ширине колонки: на десктопе
  // до десяти знаков («yandex-dire…»), на телефоне до одной буквы.
  it('показывает длинную подпись целиком', () => {
    const long = 'yandex-direct / cpc-поиск-брендовые-запросы'
    render(<BreakdownList label="Источник" rows={[{ key: 'a', label: long, visits: 30, submitted: 3 }]} />)
    expect(screen.getByText(long)).toBeTruthy()
  })

  it('восемь строк показывает без кнопки', () => {
    render(<BreakdownList label="Источник" rows={rows(8)} />)
    expect(screen.getAllByRole('row')).toHaveLength(9) // восемь строк и шапка
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('хвост прячет за кнопку и разворачивает по щелчку', async () => {
    render(<BreakdownList label="Источник" rows={rows(20)} />)
    expect(screen.queryByText('Строка 9')).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: 'Показать ещё 12' }).click()
    })

    expect(screen.getByText('Строка 20')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Свернуть' })).toBeTruthy()
  })

  it('пустая разбивка объясняется словом, а не пустотой', () => {
    render(<BreakdownList label="Источник" rows={[]} />)
    expect(screen.getByText('Данных нет.')).toBeTruthy()
  })
})
