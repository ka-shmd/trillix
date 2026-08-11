import { describe, expect, it } from 'vitest'

import { type Block, textFromString } from '@entities/formSchema'
import { groupBlocks, packGroupRows, packRows, type Row } from '@fields/groups'

import { type Box, pickDropTarget } from './dropTarget'

// Правило прицеливания: цель — элемент под указателем, линия всегда под ним. Жест
// проверяется мышью и в vitest не воспроизводится, поэтому здесь проверяется то, что
// жест решает ДО всякого DOM: какая позиция выбрана и что мерить под линию.
//
// Геометрия синтетическая и это осознанно: она ВХОД функции, а не её вывод. Пиксельные
// константы теста свои, а вот СТРУКТУРУ (что с чем в ряду, что внутри вопроса) строит
// настоящий раскладчик — иначе тест проверял бы собственное представление о полотне.

let seq = 0
const blk = (type: Block['type'], extra: Partial<Block> = {}): Block => ({
  id: `b${++seq}`,
  type,
  groupId: `g${seq}`,
  text: textFromString(''),
  required: false,
  ...extra,
})

const layout = (blocks: Block[]) => packRows(groupBlocks(blocks))

const H = 40 // высота строки
const GAP_ROW = 28 // между вопросами (gap-7)
const GAP_IN = 14 // внутри вопроса (gap-3.5)
const GUTTER = 28 // жёлоб между колонками
const W = 700 // ширина холста

type Group = { id: string; blocks: Block[] }

// Раскладка в пиксели по той же вложенности, что рисует полотно: ряды сверху вниз,
// колонки слева направо, внутри колонки стопка групп, внутри группы — её внутренние
// ряды.
function boxesOf(rows: Row<Group>[]): Map<string, Box> {
  const out = new Map<string, Box>()
  let y = 0
  for (const row of rows) {
    const colW = (W - GUTTER * (row.length - 1)) / row.length
    let rowBottom = y
    row.forEach((cell, ci) => {
      const left = ci * (colW + GUTTER)
      let cy = y
      cell.forEach((group, gi) => {
        if (gi > 0) cy += GAP_ROW
        for (const inner of packGroupRows(group.blocks)) {
          const iw = (colW - GUTTER * (inner.length - 1)) / inner.length
          let tallest = 0
          inner.forEach((stack, ii) => {
            const il = left + ii * (iw + GUTTER)
            stack.forEach((b, bi) => {
              const top = cy + bi * (H + GAP_IN)
              out.set(b.id, { top, bottom: top + H, left: il, right: il + iw })
            })
            tallest = Math.max(tallest, stack.length * H + (stack.length - 1) * GAP_IN)
          })
          cy += tallest + GAP_IN
        }
        cy -= GAP_IN // последний внутренний ряд просвета после себя не занимает
      })
      rowBottom = Math.max(rowBottom, cy)
    })
    y = rowBottom + GAP_ROW
  }
  return out
}

// Точка «в середине этого блока» — так, как в него целится автор.
const on = (boxes: Map<string, Box>, id: string) => {
  const b = boxes.get(id)!
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }
}

const pick = (blocks: Block[], at: string, activeId: string, layer: 'block' | 'group' = 'block') => {
  const rows = layout(blocks)
  const boxes = boxesOf(rows)
  return pickDropTarget(rows, boxes, on(boxes, at), { layer, activeId })
}

describe('pickDropTarget — линия всегда под элементом под указателем', () => {
  it('одиночки: цель — тот блок, на который смотрит автор', () => {
    const a = blk('text')
    const b = blk('text')
    const c = blk('text')
    const d = blk('text')

    expect(pick([a, b, c, d], b.id, d.id)).toEqual({
      afterId: b.id,
      lineIds: [b.id],
      before: false,
    })
    expect(pick([a, b, c, d], c.id, d.id)).toEqual({
      afterId: c.id,
      lineIds: [c.id],
      before: false,
    })
  })

  // Главная жалоба на прежний жест: одна и та же точка значила разное в зависимости от
  // того, откуда элемент приехал (swap-семантика dnd-kit выводила сторону из индексов).
  it('направление драга на выбор не влияет', () => {
    const a = blk('text')
    const b = blk('text')
    const c = blk('text')
    const d = blk('text')
    const e = blk('text')
    const blocks = [a, b, c, d, e]

    const fromAbove = pick(blocks, c.id, a.id)
    const fromBelow = pick(blocks, c.id, e.id)
    expect(fromAbove).toEqual(fromBelow)
    expect(fromAbove?.afterId).toBe(c.id)
  })

  it('выше первого ряда — «встать первым»: линия НАД ним', () => {
    const a = blk('text')
    const b = blk('text')
    const rows = layout([a, b])
    const boxes = boxesOf(rows)

    expect(pickDropTarget(rows, boxes, { x: W / 2, y: -20 }, { layer: 'block', activeId: b.id }))
      .toEqual({ afterId: null, lineIds: [a.id], before: true })
  })

  it('активный элемент не цель самому себе — ни адресом, ни составом линии', () => {
    const a = blk('text')
    const b = blk('text')
    const c = blk('text')

    const t = pick([a, b, c], b.id, b.id)
    expect(t?.afterId).toBe(a.id)
    expect(t?.lineIds).not.toContain(b.id)
  })
})

describe('pickDropTarget — вопрос из нескольких строк', () => {
  const question = () => {
    const gid = `q${++seq}`
    return {
      caption: blk('title', { groupId: gid }),
      field: blk('short_text', { groupId: gid }),
    }
  }

  it('указатель на подписи — линия под подписью, блок войдёт ВНУТРЬ вопроса', () => {
    const { caption, field } = question()
    const other = blk('text')

    expect(pick([caption, field, other], caption.id, other.id)).toEqual({
      afterId: caption.id,
      lineIds: [caption.id],
      before: false,
    })
  })

  it('указатель на последней строке — линия под ВОПРОСОМ, во всю его ширину', () => {
    const { caption, field } = question()
    const other = blk('text')

    expect(pick([caption, field, other], field.id, other.id)).toEqual({
      afterId: field.id,
      lineIds: [caption.id, field.id],
      before: false,
    })
  })

  it('групповой слой внутрь вопроса не заходит: любая его строка — «после вопроса»', () => {
    const { caption, field } = question()
    const other = blk('text')
    const blocks = [caption, field, other]

    const atCaption = pick(blocks, caption.id, other.groupId, 'group')
    const atField = pick(blocks, field.id, other.groupId, 'group')
    expect(atCaption).toEqual(atField)
    expect(atCaption).toEqual({ afterId: field.id, lineIds: [caption.id, field.id], before: false })
  })
})

describe('pickDropTarget — ряд атомарен для вертикальной вставки', () => {
  // Порт правила, которое прежде было подменой цели постфактум (rowBoundaryTarget и
  // rowBoundaryGroup). Пришелец между участниками ряда приходит без бита колонки и
  // пересобирает секцию новым составом — позиция исключена из набора целей.
  const section = () => {
    const left = blk('short_text')
    const right = blk('email', { settings: { column: 2 } })
    return { left, right }
  }

  it('щель между колонками отдана границе ряда: линия во всю ширину', () => {
    const { left, right } = section()
    const outsider = blk('text')
    const rows = layout([left, right, outsider])
    expect(rows[0]).toHaveLength(2)

    const t = pick([left, right, outsider], left.id, outsider.id)
    expect(t).toEqual({ afterId: right.id, lineIds: [left.id, right.id], before: false })
  })

  // Ряд из ТРЁХ колонок, потому что на двух правило неразличимо: вычеркнув активного
  // участника, граница ряда съезжает ровно на ту позицию, которую разрешает исключение,
  // и тест проходил бы при любой реализации.
  it('участник СВОЕГО ряда щель между колонками занимать вправе', () => {
    const a = blk('short_text')
    const b = blk('email', { settings: { column: 2 } })
    const c = blk('text', { settings: { column: 3 } })
    const outsider = blk('text')
    const rows = layout([a, b, c, outsider])
    expect(rows[0]).toHaveLength(3)

    // Тащит участник ряда — щель за средней колонкой законная цель.
    expect(pick([a, b, c, outsider], b.id, a.id)).toEqual({
      afterId: b.id,
      lineIds: [b.id],
      before: false,
    })
    // Тот же указатель, но тащат СНАРУЖИ — полоса отдана границе ряда.
    expect(pick([a, b, c, outsider], b.id, outsider.id)).toEqual({
      afterId: c.id,
      lineIds: [a.id, b.id, c.id],
      before: false,
    })
  })

  it('колонку выбирает X указателя', () => {
    const { left, right } = section()
    const below = blk('text')
    const rows = layout([left, right, below])
    const boxes = boxesOf(rows)
    const y = boxes.get(left.id)!.top + H / 2

    const atLeft = pickDropTarget(rows, boxes, { x: 40, y }, { layer: 'block', activeId: right.id })
    const atRight = pickDropTarget(rows, boxes, { x: W - 40, y }, { layer: 'block', activeId: left.id })
    expect(atLeft?.afterId).toBe(left.id)
    expect(atRight?.afterId).toBe(right.id)
  })

  it('просвет ПОД рядом принадлежит ряду, а не колонке под ним', () => {
    const { left, right } = section()
    const below = blk('text')
    const rows = layout([left, right, below])
    const boxes = boxesOf(rows)
    const y = boxes.get(left.id)!.bottom + GAP_ROW / 2

    const t = pickDropTarget(rows, boxes, { x: 40, y }, { layer: 'block', activeId: below.id })
    expect(t).toEqual({ afterId: right.id, lineIds: [left.id, right.id], before: false })
  })

  it('вставка контента ВНУТРЬ участника ряда остаётся легальной', () => {
    const gid = 'q'
    const caption = blk('title', { groupId: gid })
    const field = blk('short_text', { groupId: gid })
    const right = blk('email', { settings: { column: 2 } })
    const outsider = blk('text')
    const rows = layout([caption, field, right, outsider])
    expect(rows[0]).toHaveLength(2)

    const t = pick([caption, field, right, outsider], caption.id, outsider.id)
    expect(t).toEqual({ afterId: caption.id, lineIds: [caption.id], before: false })
  })

  it('внутренний ряд «подпись | поле»: щель между ними — не позиция', () => {
    const gid = 'q'
    const caption = blk('title', { groupId: gid })
    const field = blk('short_text', { groupId: gid, settings: { column: 2 } })
    const outsider = blk('text')
    const rows = layout([caption, field, outsider])
    expect(packGroupRows(rows[0]![0]![0]!.blocks)[0]).toHaveLength(2)

    const t = pick([caption, field, outsider], caption.id, outsider.id)
    expect(t).toEqual({ afterId: field.id, lineIds: [caption.id, field.id], before: false })
  })
})
