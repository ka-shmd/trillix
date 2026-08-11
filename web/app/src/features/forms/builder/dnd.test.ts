import { describe, expect, it } from 'vitest'

import { closestCenter, type ClientRect, type CollisionDetection } from '@dnd-kit/core'

import { closestVertical } from './dnd'

// Числа — как в живом DOM: строка меряется border-box'ом (BlockRow добавляет py-1.5, li
// гасит его -my-1.5), поэтому просвет 14px ритма даёт 2px между прямоугольниками, а
// 28px — 16px. Полоса полотна — 700px, колонка секции — 336px при 28px-жёлобе.

const CANVAS = 700
const COL = 336
const GUTTER = 28

const rect = (top: number, height: number, left = 0, width = CANVAS): ClientRect => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
})


// Тесты расступания строк сняты вместе с самим расступанием (2026-08-11, решение
// владельца): соседи при перетаскивании больше не двигаются, место вставки называет
// линия поверх неподвижной раскладки. Проверять «кто куда сдвинулся» стало нечего —
// стратегия трогает только сам перетаскиваемый элемент (drop-анимация и клавиатурный
// перенос), а геометрия линии живёт в SlashEditor и меряется по живому DOM.

describe('closestVertical', () => {
  const named: Record<string, ClientRect> = {
    textA: rect(0, 36),
    textB: rect(52, 36),
    rowLeft: rect(104, 36, 0, COL),
    rowRight: rect(104, 36, COL + GUTTER, COL),
    q1caption: rect(168, 40),
    q1field: rect(210, 40),
    q2caption: rect(278, 40),
  }

  const pick = (detect: CollisionDetection, activeId: string, centerY: number): string => {
    const rects = new Map(Object.entries(named).filter(([id]) => id !== activeId))
    const hit = detect({
      active: { id: activeId, data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
      collisionRect: rect(centerY - 18, 36),
      droppableRects: rects,
      droppableContainers: [...rects.keys()].map((id) => ({ id })) as never,
      pointerCoordinates: null,
    })
    return String(hit[0]!.id)
  }

  // Курсор в просвете МЕЖДУ рядом и первым коротким ответом: там и ждут дроп «под ряд».
  const gapBelowRow = 154

  it('в просвете под рядом целью становится РЯД, а не подпись следующего вопроса', () => {
    expect(pick(closestVertical, 'textB', gapBelowRow)).toMatch(/^row/)
  })

  it('closestCenter на том же месте выбирает подпись следующего вопроса — блок уходит внутрь него', () => {
    expect(pick(closestCenter, 'textB', gapBelowRow)).toBe('q1caption')
  })

  it('ряд не перепрыгивается: на его высоте цель — он сам', () => {
    expect(pick(closestVertical, 'q1caption', 122)).toMatch(/^row/)
    // А по евклидовой метрике «ближе» оказывается текст НАД рядом, хотя он дальше:
    // ряд отстоит по вертикали на 0, но на 182 вбок.
    expect(pick(closestCenter, 'q1caption', 122)).toBe('textB')
  })

  it('вне ряда ведёт себя как обычный ближайший: полноширинные цели не путаются', () => {
    expect(pick(closestVertical, 'textA', 60)).toBe('textB')
    expect(pick(closestVertical, 'textA', 290)).toBe('q2caption')
  })
})
