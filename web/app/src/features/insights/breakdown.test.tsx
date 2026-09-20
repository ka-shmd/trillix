// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { BarRows, BreakdownList, type BreakdownRow } from './Breakdown'

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

// Строка-полоска умеет две вещи сверх показа величины: раскрываться в свои
// подстроки (страница воронки — в вопросы) и применять себя к выборке экрана
// (вариант ответа — в условие фильтра).
describe('BarRows', () => {
  const page = {
    key: 'page:p1',
    label: 'Страница 1',
    value: '75 · 75 %',
    share: 0.75,
    children: [
      { key: 'q1', label: '1. Имя', value: '70 · 70 %', share: 0.7 },
      { key: 'q2', label: '2. Почта', value: '50 · 50 %', share: 0.5 },
    ],
  }

  it('вложенные строки прячет до щелчка', async () => {
    render(<BarRows columns={{ label: 'Шаг', value: 'Дошли' }} rows={[page]} />)
    expect(screen.queryByText('1. Имя')).toBeNull()

    const toggle = screen.getByRole('button', { name: 'Страница 1' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      toggle.click()
    })

    expect(screen.getByText('1. Имя')).toBeTruthy()
    expect(screen.getByText('2. Почта')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Страница 1' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
  })

  it('строку без детей и без действия кнопкой не делает', () => {
    render(
      <BarRows
        columns={{ label: 'Шаг', value: 'Дошли' }}
        rows={[{ key: 'a', label: 'Открыли форму', value: '100', share: 1 }]}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  // МИНА: цель щелчка — вся строка (обработчик на tr), а имя и клавиатура — у
  // настоящей кнопки внутри неё. Без stopPropagation нажатие на кнопку всплывало бы
  // до строки, и одно нажатие применяло бы условие дважды — то есть применяло и
  // тут же снимало.
  it('щелчок по строке с действием срабатывает ровно раз', async () => {
    const calls: string[] = []
    render(
      <BarRows
        columns={{ label: 'Вариант', value: 'Ответы' }}
        rows={[
          {
            key: 'msk',
            label: 'Москва',
            value: '31 · 31 %',
            share: 0.31,
            onSelect: () => calls.push('msk'),
            actionLabel: 'Оставить только «Москва»',
          },
        ]}
      />,
    )
    await act(async () => {
      screen.getByRole('button', { name: 'Оставить только «Москва»' }).click()
    })
    expect(calls).toEqual(['msk'])
  })
})
