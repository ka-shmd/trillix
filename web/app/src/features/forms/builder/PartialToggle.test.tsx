// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, cleanup, render, screen } from '@testing-library/react'

import { PartialToggle } from './PartialToggle'

afterEach(cleanup)

// Дефект, из-за которого тест и написан: у НОВОЙ формы за одним кликом стоят два
// запроса подряд — создание самой формы и PATCH тумблера. Пока они идут,
// контролируемый серверным значением переключатель оставался в старом положении, и
// клик выглядел несработавшим.
describe('тумблер сбора незавершённых', () => {
  it('переключается сразу, не дожидаясь сервера', async () => {
    // Обещание, которое НИКОГДА не разрешается, — модель медленной сети.
    const onToggle = vi.fn(() => new Promise<void>(() => {}))
    render(<PartialToggle checked={false} onToggle={onToggle} />)

    const toggle = screen.getByRole('switch')
    await act(async () => {
      toggle.click()
    })

    expect(toggle.getAttribute('data-state')).toBe('checked')
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('на ошибке возвращается в серверное положение', async () => {
    // Тумблер не имеет права врать про сбор, которого нет: отказ тарифа обязан
    // вернуть его выключенным.
    const onToggle = vi.fn(() => Promise.reject(new Error('plan_required')))
    render(<PartialToggle checked={false} onToggle={onToggle} />)

    const toggle = screen.getByRole('switch')
    await act(async () => {
      toggle.click()
    })

    expect(toggle.getAttribute('data-state')).toBe('unchecked')
  })

  it('после успеха остаётся там, куда его поставили', async () => {
    // Серверное значение у новой формы подтягивается позже (и может отставать
    // целый круг), поэтому сбрасывать локальное после успеха нельзя — тумблер
    // моргнул бы обратно.
    let resolve = () => {}
    const onToggle = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    render(<PartialToggle checked={false} onToggle={onToggle} />)

    const toggle = screen.getByRole('switch')
    await act(async () => {
      toggle.click()
    })
    await act(async () => {
      resolve()
    })

    expect(toggle.getAttribute('data-state')).toBe('checked')
  })
})
