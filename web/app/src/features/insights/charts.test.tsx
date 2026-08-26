// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { ShareChart } from './ShareChart'
import { FunnelChart } from './FunnelChart'
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

// Текст подписей осей: recharts вешает на body служебный span для измерения
// строки, поэтому getByText находит каждую подпись дважды. Читаем только то, что
// нарисовано в самом SVG.
function svgText(container: HTMLElement): string[] {
  return [...container.querySelectorAll('svg tspan, svg text')].map((n) => n.textContent ?? '')
}

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

describe('FunnelChart', () => {
  it('рисует ступени и шаги одной полосой каждый', () => {
    const funnel = {
      visits: 100,
      submitted: 20,
      leftBeforeFirst: 10,
      steps: [
        { blockId: 'a', label: 'Имя', reached: 90, droppedHere: 30 },
        { blockId: 'b', label: 'Телефон', reached: 60, droppedHere: 40 },
      ],
    }
    const { container } = render(<FunnelChart funnel={funnel} />)
    // Две ступени плюс два вопроса.
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(4)
    // Подписи ступеней и вопросов — ось Y, она рисуется сразу. Числа у концов
    // полосок (LabelList) появляются вместе с анимацией и в happy-dom не наступают;
    // сама строка «N · M %» проверена юнитом percentOf в metrics.test.ts.
    expect(svgText(container)).toContain('Открыли форму')
    expect(svgText(container)).toContain('2. Телефон')
    expect(svgText(container)).toContain('Отправили форму')
  })

  // Длинная подпись обрезается в оси, а не переносится: это текст внутри SVG.
  it('обрезает длинную подпись вопроса', () => {
    const long = 'Расскажите, как вы узнали о нашем сервисе и что вас в нём заинтересовало'
    const { container } = render(
      <FunnelChart
        funnel={{
          visits: 10,
          submitted: 1,
          leftBeforeFirst: 0,
          steps: [{ blockId: 'a', label: long, reached: 9, droppedHere: 8 }],
        }}
      />,
    )
    expect(svgText(container).some((t) => /^1\. Расскажите.*…$/.test(t))).toBe(true)
  })
})

describe('ShareChart', () => {
  function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({ label: `Строка ${i + 1}`, visits: n - i }))
  }

  it('называет доли и рисует кольцо', () => {
    const { container, getByText } = render(
      <ShareChart
        rows={[
          { label: 'Компьютер', visits: 3 },
          { label: 'Телефон', visits: 1 },
        ]}
      />,
    )
    // Секторы кольца здесь НЕ проверяются: recharts рисует их анимацией, а первый
    // кадр в happy-dom не наступает — слой остаётся пустым. В браузере он не пустой
    // (проверено тем же тестом с выключенной анимацией). Осмысленная часть кольца
    // всё равно наша: подписи и доли рядом с ним.
    expect(container.querySelector('.recharts-pie')).toBeTruthy()
    expect(getByText('3 · 75 %')).toBeTruthy()
  })

  // Восемь строк — потолок секторов. Ровно восемь ещё помещаются целиком, и
  // «Прочее» на них появляться не должно: пустая группа это лишний сектор.
  it('восемь строк показывает целиком, без «Прочего»', () => {
    const { queryByText, getAllByRole } = render(<ShareChart rows={rows(8)} />)
    expect(queryByText('Прочее')).toBeNull()
    expect(getAllByRole('listitem')).toHaveLength(8)
  })

  it('девятую и дальше сворачивает в «Прочее» с их суммой', () => {
    // 12 строк: 12+11+…+1 = 78 всего, хвост (строки 9..12) = 4+3+2+1 = 10.
    // Число ищем ВНУТРИ строки «Прочее»: у третьей строки визитов ровно столько же,
    // и поиск по тексту нашёл бы обе.
    const { getAllByRole } = render(<ShareChart rows={rows(12)} />)
    const items = getAllByRole('listitem')
    expect(items).toHaveLength(9)
    const other = items.at(-1)
    expect(other?.textContent).toContain('Прочее')
    expect(other?.textContent).toContain('10 · 13 %')
  })
})
