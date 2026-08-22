import { useEffect, useRef, useState } from 'react'

import { COLUMN_WIDTH_TOTAL } from '@entities/formSchema'
import { nextWidths, pxToWidths } from './columnResize'

// РУЧКА ШИРИНЫ КОЛОНКИ (2026-08-22, ADR §10) — вертикальная линия в жёлобе слева от
// своей колонки: тащишь её, и граница едет за курсором, а пара колонок по её сторонам
// делит между собой прежнюю сумму. Стоит у всех колонок ряда, кроме первой (слева от
// неё границы нет), и только у настоящей секции.
//
// ДОЛИ ВО ВРЕМЯ ЖЕСТА ПИШУТСЯ ПРЯМО В DOM, минуя стор: полотно перерисовывается целиком
// (TD-32), и коммит на каждом кадре превратил бы плавную границу в рывки — тот же урок,
// что у драга (§5.3 «цена кадра»). В стор уезжает одна правка на отпускание, поэтому
// Mod+Z откатывает жест целиком, а не по кадрам.
//
// Ячейки ряда ищутся по `data-rf-cell`, а не по позиции среди детей: в ряду полотна
// рядом с колонками живут зоны драга, и «все дети» захватили бы их.
//
// Escape отменяет начатое перетаскивание — доли возвращаются к тем, что были в DOM до
// захвата (у ряда без долей это пустая строка, то есть «поровну из CSS»).
export function ColumnResizer({
  index,
  gutter,
  onCommit,
}: {
  // Индекс СВОЕЙ колонки: ручка стоит на границе между index-1 и index.
  index: number
  // Ширина жёлоба слоя: 16px между вопросами, 14px внутри вопроса, 12px у вариантов.
  gutter: number
  onCommit: (widths: number[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    cells: HTMLElement[]
    before: string[]
    base: number[]
    widths: number[]
    span: number
    startX: number
  } | null>(null)
  const [active, setActive] = useState(false)

  // Отмена по Escape и уборка захвата, если компонент размонтировали посреди жеста
  // (соседний блок удалили, ряд распался).
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function finish(commit: boolean) {
    const d = drag.current
    if (!d) return
    drag.current = null
    setActive(false)
    if (commit && d.widths.some((w, i) => w !== d.base[i])) {
      // Inline-доли НЕ стираем: коммит вернётся теми же числами через рендер, и
      // стирание между ними дало бы кадр с равными колонками.
      onCommit(d.widths)
      return
    }
    d.cells.forEach((c, i) => {
      c.style.flexGrow = d.before[i]!
    })
  }

  return (
    <div
      ref={ref}
      aria-hidden="true"
      // Хит-область — весь жёлоб (как у зоны драга), видимая линия внутри тоньше:
      // попасть в 2px мышью нельзя, а обещать 2px — можно.
      data-rf-resizer=""
      className="group absolute top-0 bottom-0 z-10 -translate-x-1/2 cursor-col-resize touch-none"
      style={{ left: -gutter / 2, width: gutter }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const handle = ref.current
        const cell = handle?.parentElement
        const row = cell?.parentElement
        if (!handle || !row) return
        const cells = [...row.querySelectorAll<HTMLElement>(':scope > [data-rf-cell]')]
        if (cells.length < 2 || index < 1 || index >= cells.length) return
        const px = cells.map((c) => c.getBoundingClientRect().width)
        const base = pxToWidths(px)
        drag.current = {
          cells,
          before: cells.map((c) => c.style.flexGrow),
          base,
          widths: base,
          span: px.reduce((a, b) => a + b, 0),
          startX: e.clientX,
        }
        handle.setPointerCapture(e.pointerId)
        setActive(true)
        // Ни выделения текста под курсором, ни драга строки: сенсор dnd-kit слушает
        // тот же pointerdown, и без остановки жест уводил бы вопрос вместо границы.
        e.preventDefault()
        e.stopPropagation()
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const delta = Math.round(((e.clientX - d.startX) / d.span) * COLUMN_WIDTH_TOTAL)
        const widths = nextWidths(d.base, index, delta)
        d.widths = widths
        d.cells.forEach((c, i) => {
          c.style.flexGrow = String(widths[i])
        })
      }}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
    >
      {/* Линия видна по наведению НА ЖЁЛОБ и на всё время жеста: в покое полотно не
          показывает органов управления, которых автор не спрашивал. Наведение ловит
          хит-область (group), а не сама линия: попасть мышью в 2px нельзя. Вес и цвет
          — те же, что у рейла зоны драга: это одна и та же граница ряда. */}
      <span
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-primary transition-opacity ${
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      />
    </div>
  )
}
