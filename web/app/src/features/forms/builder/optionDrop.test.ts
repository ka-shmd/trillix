import { describe, expect, it } from 'vitest'

import { type Box } from './dropTarget'
import {
  inviteOptionRowId,
  optionUnits,
  optionZoneId,
  optionZoneTarget,
  pickHoverOption,
  pickOptionTarget,
} from './optionDrop'

// Слой вариантов ведёт себя как полотно: линия под тем вариантом, на который смотрит
// указатель, ряд атомарен для полноширинной вставки, щель внутри колонки несёт её номер.
// Само правило проверено у полотна (dropTarget.test.ts) — здесь проверяется ПЕРЕВОД:
// что список раскладывается в единицы своим раскладчиком и что ответы приходят те же.

type Opt = { id: string; column?: number }
const opt = (id: string, column?: number): Opt => (column === undefined ? { id } : { id, column })

const H = 24 // высота карточки варианта
const GAP = 12 // ритм списка (.rf-options)
const GUTTER = 28 // жёлоб между колонками
const W = 700

// Раскладка списка в пиксели по той же вложенности, что рисует BlockRow: ряды сверху
// вниз, колонки слева направо, внутри колонки стопка карточек.
function boxesOf(options: Opt[]): Map<string, Box> {
  const out = new Map<string, Box>()
  let y = 0
  for (const row of optionUnits(options)) {
    const colW = (W - GUTTER * (row.length - 1)) / row.length
    let bottom = y
    row.forEach((cell, ci) => {
      const left = ci * (colW + GUTTER)
      cell.forEach((u, i) => {
        const top = y + i * (H + GAP)
        out.set(u.id, { top, bottom: top + H, left, right: left + colW })
        bottom = Math.max(bottom, top + H)
      })
    })
    y = bottom + GAP
  }
  return out
}

const on = (boxes: Map<string, Box>, id: string) => {
  const b = boxes.get(id)!
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }
}

const pick = (options: Opt[], at: string, activeId: string) => {
  const boxes = boxesOf(options)
  return pickOptionTarget(optionUnits(options), boxes, on(boxes, at), activeId)
}

describe('цель дропа у вариантов', () => {
  it('линия ПОД вариантом, на который смотрит указатель', () => {
    const options = [opt('a'), opt('b'), opt('c')]
    expect(pick(options, 'b', 'c')).toEqual({ afterId: 'b', lineIds: ['b'], before: false })
  })

  it('указатель выше первого варианта — «встать первым»', () => {
    const options = [opt('a'), opt('b')]
    const boxes = boxesOf(options)
    expect(pickOptionTarget(optionUnits(options), boxes, { x: W / 2, y: -20 }, 'b')).toEqual({
      afterId: null,
      lineIds: ['a'],
      before: true,
    })
  })

  it('перетаскиваемый вариант целью не бывает: щель над ним принадлежит соседу сверху', () => {
    const options = [opt('a'), opt('b'), opt('c')]
    // Указатель на самом себе — ответ даёт цель сверху («после a»), а не «после b».
    expect(pick(options, 'b', 'b')).toEqual({ afterId: 'a', lineIds: ['a'], before: false })
  })

  it('ряд атомарен: щели МЕЖДУ колонками нет, есть граница ряда во всю ширину', () => {
    const options = [opt('a'), opt('b', 2), opt('c')]
    const boxes = boxesOf(options)
    expect(optionUnits(options)[0]).toHaveLength(2)
    // Куда бы ни целился указатель внутри ряда — слева, справа, — ответ один: под рядом.
    const under = { afterId: 'b', lineIds: ['a', 'b'], before: false }
    const y = boxes.get('a')!.top + H / 2
    expect(pickOptionTarget(optionUnits(options), boxes, { x: 40, y }, 'c')).toEqual(under)
    expect(pickOptionTarget(optionUnits(options), boxes, { x: W - 40, y }, 'c')).toEqual(under)
  })

  it('щель ВНУТРИ колонки несёт её номер: дроп бит не снимает, а ставит', () => {
    // Секция: слева стопка a+c, справа b. Порядок документа колоночный (канон стора).
    const options = [opt('a', 1), opt('c', 1), opt('b', 2)]
    const boxes = boxesOf(options)
    const rows = optionUnits(options)
    expect(rows[0]).toHaveLength(2)
    expect(rows[0]![0]).toHaveLength(2)
    // Указатель ПОПАЛ в левую колонку и стоит на a — первом её живом участнике.
    expect(pickOptionTarget(rows, boxes, on(boxes, 'a'), 'x')).toEqual({
      afterId: 'a',
      lineIds: ['a'],
      before: false,
      column: 1,
    })
    // После ПОСЛЕДНЕГО участника колонки щели нет — там граница ряда, то есть выход из
    // ряда во всю ширину. Адрес — хвост ряда по документу.
    expect(pickOptionTarget(rows, boxes, on(boxes, 'c'), 'x')).toEqual({
      afterId: 'b',
      lineIds: ['a', 'c', 'b'],
      before: false,
    })
  })
})

describe('приглашение «встань в ряд» у вариантов', () => {
  const rows = () => optionUnits([opt('a'), opt('b', 2), opt('c')])

  it('адрес ряда — участник, отличный от перетаскиваемого', () => {
    // Тащим a — участника этого же ряда: адресом обязан стать b, иначе placeOptionInRow
    // выйдет на active === target и не сделает ничего.
    expect(inviteOptionRowId(rows(), 'a', 'a')).toBe('b')
    expect(inviteOptionRowId(rows(), 'b', 'c')).toBe('a')
  })

  it('ряд, где стоит только перетаскиваемый вариант, не приглашает', () => {
    expect(inviteOptionRowId(rows(), 'c', 'c')).toBeNull()
  })

  it('указателя нет над списком — приглашения нет', () => {
    expect(inviteOptionRowId(rows(), null, 'a')).toBeNull()
  })

  it('вариант под указателем — ближайший, а не только тот, в чей бокс попали', () => {
    const options = [opt('a'), opt('b')]
    const boxes = boxesOf(options)
    // Точка в жёлобе между вариантами: «мимо всех» здесь штатное состояние.
    const y = boxes.get('a')!.bottom + GAP / 2
    expect(pickHoverOption(optionUnits(options), boxes, { x: W / 2, y }, 'x')).toBe('a')
  })
})

describe('пространство id зон', () => {
  it('id зоны разбирается обратно и с id варианта не путается', () => {
    expect(optionZoneTarget(optionZoneId('o1', 2, true))).toEqual({
      optionId: 'o1',
      col: 2,
      insert: true,
    })
    expect(optionZoneTarget(optionZoneId('o1', 3, false))).toEqual({
      optionId: 'o1',
      col: 3,
      insert: false,
    })
    expect(optionZoneTarget('o1')).toBeNull()
  })
})
