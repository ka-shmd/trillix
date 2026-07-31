// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { useGlobalChord } from './useGlobalChord'

// Глобальные аккорды полотна (история Mod+Z/Mod+Y, шпаргалка Mod+/) слушают window и
// ловят событие откуда угодно — для строк полотна это осознанно (Mod+Z откатывает
// документ, а не набор символов). Фаза 16 добавляет попап настроек, и там то же
// правило значит «правлю поле — теряю документ».
//
// Правило одно на оба слушателя и живёт в useGlobalChord, поэтому проверяется здесь:
// два слушателя со своими проверками разъехались бы молча.

afterEach(cleanup)

function Probe({ onKey }: { onKey: (e: KeyboardEvent) => void }) {
  useGlobalChord(onKey)
  return (
    <>
      {/* Поверхность полотна: обычная строка вне всплывающих слоёв. */}
      <textarea data-testid="row" defaultValue="Как вас зовут?" />
      {/* Попап настроек блока: shadcn-поповер несёт data-slot, внутри — поле. */}
      <div data-slot="popover-content">
        <input data-testid="popup-field" />
        <button data-testid="popup-item" type="button">
          Дублировать
        </button>
      </div>
      {/* Шпаргалка Mod+/ — диалог БЕЗ полей: её тот же аккорд обязан закрывать. */}
      <div role="dialog" data-testid="sheet">
        <p>Карта клавиш</p>
      </div>
    </>
  )
}

function press(el: Element) {
  el.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', ctrlKey: true, bubbles: true }))
}

describe('глобальный аккорд полотна', () => {
  it('срабатывает из строки полотна', () => {
    const onKey = vi.fn()
    const { getByTestId } = render(<Probe onKey={onKey} />)

    press(getByTestId('row'))

    expect(onKey).toHaveBeenCalledTimes(1)
  })

  it('не срабатывает из поля во всплывающем слое', () => {
    const onKey = vi.fn()
    const { getByTestId } = render(<Probe onKey={onKey} />)

    press(getByTestId('popup-field'))

    expect(onKey).not.toHaveBeenCalled()
  })

  it('срабатывает из самого всплывающего слоя, если цель — не поле', () => {
    const onKey = vi.fn()
    const { getByTestId } = render(<Probe onKey={onKey} />)

    // Пункт попапа и тело шпаргалки — не поля ввода: закрыть шпаргалку тем же
    // аккордом, которым её открыли, обязано работать.
    press(getByTestId('popup-item'))
    press(getByTestId('sheet'))

    expect(onKey).toHaveBeenCalledTimes(2)
  })

  it('снимает слушатель при размонтировании', () => {
    const onKey = vi.fn()
    const { unmount } = render(<Probe onKey={onKey} />)

    unmount()
    // Событие шлём В САМО ОКНО, а не в снятую со страницы строку: у оторванного узла
    // событие до window и так не всплывёт, и тест был бы зелёным при живом слушателе.
    press(window as unknown as Element)

    expect(onKey).not.toHaveBeenCalled()
  })
})
