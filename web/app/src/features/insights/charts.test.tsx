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
  it('рисует по полоске на строку', () => {
    const rows = [
      { key: 'opened', label: 'Открыли форму', reached: 100, dropped: 10 },
      { key: 'page:', label: 'Страница 1', reached: 90, dropped: 30 },
      { key: 'page:pb1', label: 'Контакты', reached: 60, dropped: 40 },
      { key: 'submitted', label: 'Отправили форму', reached: 20, dropped: 0 },
    ]
    const { container } = render(<FunnelChart rows={rows} base={100} />)
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(4)
    // Подписи — ось Y, она рисуется сразу. Числа у концов полосок (LabelList)
    // появляются вместе с анимацией и в happy-dom не наступают; сама строка
    // «N · M %» проверена юнитом percentOf в metrics.test.ts.
    expect(svgText(container)).toContain('Открыли форму')
    expect(svgText(container)).toContain('Контакты')
    expect(svgText(container)).toContain('Отправили форму')
  })

  // Длинная подпись обрезается в оси, а не переносится: это текст внутри SVG.
  it('обрезает длинную подпись вопроса', () => {
    const long = '1. Расскажите, как вы узнали о нашем сервисе и что вас в нём заинтересовало'
    const { container } = render(
      <FunnelChart rows={[{ key: 'a', label: long, reached: 9, dropped: 8 }]} base={10} />,
    )
    expect(svgText(container).some((t) => /^1\. Расскажите.*…$/.test(t))).toBe(true)
  })
})

describe('ShareChart', () => {
  function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({ label: `Строка ${i + 1}`, visits: n - i, submitted: 0 }))
  }

  it('называет доли и рисует кольцо', () => {
    const { container, getByText } = render(
      <ShareChart
        rows={[
          { label: 'Компьютер', visits: 3, submitted: 1 },
          { label: 'Телефон', visits: 1, submitted: 0 },
        ]}
      />,
    )
    expect(container.querySelectorAll('.recharts-pie-sector')).toHaveLength(2)
    expect(getByText('3 · 75 %')).toBeTruthy()
  })

  // Конверсия строки: над порогом малых выборок — доля, ниже — «N из M».
  it('показывает, сколько из пришедших отправили', () => {
    const { getByText } = render(
      <ShareChart
        rows={[
          { label: 'Компьютер', visits: 40, submitted: 10 },
          { label: 'Телефон', visits: 2, submitted: 2 },
        ]}
      />,
    )
    expect(getByText('25 %')).toBeTruthy()
    expect(getByText('2 из 2')).toBeTruthy()
  })

  // Восемь строк — потолок секторов. Ровно восемь ещё помещаются целиком, и
  // «Прочее» на них появляться не должно: пустая группа это лишний сектор.
  it('восемь строк показывает целиком, без «Прочего»', () => {
    const { container, queryByText, getAllByRole } = render(<ShareChart rows={rows(8)} />)
    expect(queryByText('Прочее')).toBeNull()
    expect(getAllByRole('listitem')).toHaveLength(8)
    expect(container.querySelectorAll('.recharts-pie-sector')).toHaveLength(8)
  })

  // Соседние сектора обязаны быть РАЗНОГО тона: восемь ступеней одного синего
  // человек не различает, и кольцо перестаёт отвечать на вопрос, ради которого его
  // смотрят. Тест ловит и вырождение палитры, и её расхождение с числом секторов.
  it('красит каждый сектор своим тоном', () => {
    const { container } = render(<ShareChart rows={rows(8)} />)
    const fills = [...container.querySelectorAll('.recharts-sector')].map((n) =>
      n.getAttribute('fill'),
    )
    expect(fills).toHaveLength(8)
    expect(new Set(fills).size).toBe(8)
  })

  it('девятую и дальше сворачивает в «Прочее» с их суммой', () => {
    // 12 строк: 12+11+…+1 = 78 всего, хвост (строки 9..12) = 4+3+2+1 = 10.
    // Число ищем ВНУТРИ строки «Прочее»: у третьей строки визитов ровно столько же,
    // и поиск по тексту нашёл бы обе.
    const { container, getAllByRole } = render(<ShareChart rows={rows(12)} />)
    const items = getAllByRole('listitem')
    expect(items).toHaveLength(9)
    expect(container.querySelectorAll('.recharts-pie-sector')).toHaveLength(9)
    const other = items.at(-1)
    expect(other?.textContent).toContain('Прочее')
    expect(other?.textContent).toContain('10 · 13 %')
  })
})
