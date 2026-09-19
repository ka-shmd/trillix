// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { VisitsChart } from './VisitsChart'

afterEach(cleanup)

// ХОЛСТУ НУЖЕН РАЗМЕР. recharts берёт ширину и высоту из ResizeObserver, а
// happy-dom раскладку не считает и отдаёт нули — на нулевом холсте библиотека
// молча не рисует ни одной фигуры (и пишет об этом в stderr). Заглушка сообщает
// размер сразу при observe(); без неё тесты ниже проверяли бы пустоту.
//
// getBoundingClientRect подменять НЕЛЬЗЯ: recharts меряет им легенду и подписи
// осей, и общий ответ «300 пикселей» на любой элемент съедает всю высоту графика
// под легенду — полоски снова пропадают, но уже молча.
const WIDTH = 600
const HEIGHT = 300

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(target: Element) {
        const entry = { target, contentRect: { width: WIDTH, height: HEIGHT } }
        this.cb([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    },
  )
})

// Дымовые тесты графиков. Ловят ровно одно, зато то, что иначе видно только
// глазами на живом контуре: recharts отрисовал пустой холст. Так бывает, когда
// контейнер отдаёт нулевой размер (в jsdom-подобной среде это состояние по
// умолчанию — размер держит initialDimension у ChartContainer) и когда очередная
// версия библиотеки переименовывает проп оси.
//
// Проверяем НАЛИЧИЕ фигур, а не их геометрию: координаты зависят от размера
// холста, и тест на них ломался бы от смены отступов, ничего не защищая.

const buckets = [
  { at: '2026-08-24T00:00:00Z', visits: 10, submitted: 4 },
  { at: '2026-08-25T00:00:00Z', visits: 6, submitted: 1 },
]

describe('VisitsChart', () => {
  it('рисует по столбику на корзину в каждом из двух рядов', () => {
    const { container } = render(<VisitsChart buckets={buckets} step="day" />)
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(4)
  })
})
