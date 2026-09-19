// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { Funnel } from './Funnel'
import { type FunnelRow } from './metrics'

afterEach(cleanup)

// Воронка нарисована разметкой, а не recharts (features/insights/Funnel.tsx),
// поэтому ей не нужны ни заглушка ResizeObserver, ни ожидание анимации: всё, что
// видит владелец, лежит в DOM сразу.

const rows: FunnelRow[] = [
  { key: 'opened', label: 'Открыли форму', reached: 100, dropped: 25 },
  { key: 'page:', label: 'Страница 1', reached: 75, dropped: 30 },
  { key: 'page:pb1', label: 'Контакты', reached: 45, dropped: 5 },
  { key: 'submitted', label: 'Отправили форму', reached: 40, dropped: 0 },
]

describe('Funnel', () => {
  it('рисует строку на каждый шаг с числом и долей', () => {
    render(<Funnel rows={rows} base={100} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText('100 · 100 %')).toBeTruthy()
    expect(screen.getByText('45 · 45 %')).toBeTruthy()
  })

  // РЕГРЕССИЯ. Пока воронка была графиком, подпись оси обрезалась на 28-м знаке:
  // это текст внутри SVG, он не переносится. Вопросы формы длиннее, и воронка
  // читалась как список многоточий.
  it('показывает длинную подпись целиком', () => {
    const long = '1. Расскажите, как вы узнали о нашем сервисе и что вас в нём заинтересовало'
    render(<Funnel rows={[{ key: 'a', label: long, reached: 90, dropped: 8 }]} base={100} />)
    expect(screen.getByText(long)).toBeTruthy()
  })

  // Потеря написана под своей полоской, а не спрятана в тултип: ради неё на экран
  // и заходят. У первой ступени формулировка своя — там уходят, не начав.
  it('называет потерю у каждого шага, где она есть', () => {
    render(<Funnel rows={rows} base={100} />)
    expect(screen.getByText('25 ушли, не тронув ни одного вопроса — 25 % визитов')).toBeTruthy()
    expect(screen.getByText('30 остановились здесь — 40 % дошедших')).toBeTruthy()
    // У последней ступени терять некого — строки нет.
    expect(screen.queryByText(/Отправили форму.*остановились/)).toBeNull()
  })

  it('подсвечивает худший шаг подложкой', () => {
    render(<Funnel rows={rows} base={100} worstKey="page:" />)
    const worst = screen.getByText('Страница 1').closest('li')
    const other = screen.getByText('Контакты').closest('li')
    expect(worst?.className).toContain('bg-muted')
    expect(other?.className).not.toContain('bg-muted')
  })

  // Нулевая база бывает у формы без визитов за окно. Ширина полоски считается
  // делением, и без защиты сюда приехал бы NaN в style — молча и без ошибки.
  it('переживает нулевую базу', () => {
    render(<Funnel rows={[{ key: 'a', label: 'Шаг', reached: 0, dropped: 0 }]} base={0} />)
    expect(screen.getByText('0 · 0 %')).toBeTruthy()
  })
})
