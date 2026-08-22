import { describe, expect, it } from 'vitest'

import { type Block, textFromString } from '@entities/formSchema'
import { groupBlocks, packGroupRows, packRows, type Row } from '@fields/groups'

import { type Box, pickDropTarget, pickHoverGroup } from './dropTarget'
import { createBuilderStore } from './store'

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

// Внутренние ряды вопроса — знание ПОЛОТНА, а не прицела: с обобщением на слой вариантов
// раскладчик приезжает в pickDropTarget колбэком (см. PickOpts.inner). Здесь тот же
// колбэк, что в SlashEditor, — иначе тест проверял бы другую конфигурацию.
const INNER = (blocks: Block[]) => packGroupRows(blocks).map((r) => r.flat())

const H = 40 // высота строки
// Числа — геометрия ФИКСТУРЫ, а не ритм полотна (он с 2026-08-22 везде 12px): прицел
// читает прямоугольники, и разные просветы здесь удобны тем, что промах видно по числу.
const GAP_ROW = 28 // между вопросами
const GAP_IN = 14 // внутри вопроса
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

const pick = (blocks: Block[], at: string, activeId: string, layer: 'part' | 'unit' = 'part') => {
  const rows = layout(blocks)
  const boxes = boxesOf(rows)
  return pickDropTarget(rows, boxes, on(boxes, at), { layer, inner: INNER, activeId })
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

    expect(pickDropTarget(rows, boxes, { x: W / 2, y: -20 }, { layer: 'part', inner: INNER, activeId: b.id }))
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

  // ЯКОРЬ ГРУППЫ — ЕЁ ПОСЛЕДНЯЯ СТРОКА, и это не деталь, а суть правила (владелец
  // 2026-08-11: «подсказка появляется, как только я на группу навожусь»). Полоса цели
  // «под этим вопросом» начинается у верха его ПОСЛЕДНЕЙ строки.
  //
  // И кончается у ВЕРХА следующего вопроса, а не у его якоря (владелец 2026-08-12:
  // «щель появляется, когда ты только на первом блоке нижней группы»). Значит на
  // заголовке вопроса цели нет ВООБЩЕ: щель над ним уже кончилась, щель под ним ещё не
  // началась. Указатель стоит на вопросе, а не на щели, и полотну сказать нечего.
  it('групповой слой: «под вопросом» — только на его последней строке', () => {
    const above = blk('text')
    const { caption, field } = question()
    const blocks = [above, caption, field]

    // Указатель на заголовке вопроса — ни «под абзацем», ни «под вопросом».
    expect(pick(blocks, caption.id, 'таскаем-другую-группу', 'unit')).toBeNull()
    // Дошли до последней строки — вот теперь «под вопросом», во всю его ширину.
    expect(pick(blocks, field.id, 'таскаем-другую-группу', 'unit')).toEqual({
      afterId: field.id,
      lineIds: [caption.id, field.id],
      before: false,
    })
  })

  it('групповой слой внутрь вопроса не заходит: своих строк вопрос целями не даёт', () => {
    const { caption, field } = question()
    const tail = blk('text')
    const blocks = [caption, field, tail]
    const rows = layout(blocks)
    const boxes = boxesOf(rows)
    const opts = { layer: 'unit' as const, activeId: tail.groupId }

    // На заголовке ПЕРВОГО вопроса «встать первым» уже кончилось: полоса этой позиции
    // держится, только пока указатель выше самого первого элемента полотна.
    expect(pickDropTarget(rows, boxes, on(boxes, caption.id), opts)).toBeNull()
    // А выше него — она самая, линия над первым рядом.
    expect(
      pickDropTarget(rows, boxes, { x: W / 2, y: boxes.get(caption.id)!.top - 10 }, opts),
    ).toEqual({ afterId: null, lineIds: [caption.id, field.id], before: true })
  })
})

// ПРИГЛАШЕНИЕ СМОТРИТ НА ВОПРОС, А ЛИНИЯ — НА ЩЕЛЬ, и это два разных ответа (владелец,
// 2026-08-12). Пока приглашение брали от цели дропа, оно наследовало её якорь — хвост
// вопроса — и боковые зоны загорались только у последней строки.
describe('pickHoverGroup — вопрос под указателем', () => {
  it('заголовок вопроса уже называет вопрос, хотя цель — ещё абзац выше', () => {
    const above = blk('text')
    const caption = blk('title', { groupId: 'q' })
    const field = blk('short_text', { groupId: 'q' })
    const blocks = [above, caption, field]
    const rows = layout(blocks)
    const boxes = boxesOf(rows)
    const at = on(boxes, caption.id)
    const opts = { layer: 'unit' as const, activeId: 'таскаем-другую-группу' }

    // Щели на этой точке нет вовсе: над вопросом она кончилась, под ним не началась.
    expect(pickDropTarget(rows, boxes, at, opts)).toBeNull()
    // А приглашение «встань в ряд» — уже у вопроса: колонку предлагают ему целиком.
    expect(pickHoverGroup(rows, boxes, at, opts)).toBe('q')
  })

  it('своя же группа приглашением не бывает: её строки вычеркнуты', () => {
    const a = blk('short_text')
    const b = blk('email')
    const rows = layout([a, b])
    const boxes = boxesOf(rows)

    // Указатель ровно на перетаскиваемом вопросе — назван сосед, а не он сам.
    expect(pickHoverGroup(rows, boxes, on(boxes, a.id), { layer: 'unit', activeId: a.groupId }))
      .toBe(b.groupId)
  })

  it('в жёлобе между рядами — ближайший по вертикали', () => {
    const a = blk('text')
    const b = blk('text')
    const rows = layout([a, b])
    const boxes = boxesOf(rows)
    const y = boxes.get(a.id)!.bottom + 4 // просвет сразу под первым

    expect(pickHoverGroup(rows, boxes, { x: W / 2, y }, { layer: 'part', inner: INNER, activeId: 'чужой' }))
      .toBe(a.groupId)
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

  // ИСКЛЮЧЕНИЙ У ПРАВИЛА НЕТ — в том числе для участника самого ряда (владелец,
  // 2026-08-12). Щель между колонками ему не полагается «на перестановку»: переставить
  // колонки вертикальный дроп не умеет, секцию он распускает на любом адресе
  // (§13). Ряд из ТРЁХ колонок, потому что на двух разницу не видно: вычеркнув активного,
  // граница ряда съезжает ровно на спорную позицию, и тест прошёл бы при любой
  // реализации.
  it('участнику СВОЕГО ряда щель между колонками тоже не полагается', () => {
    const a = blk('short_text')
    const b = blk('email', { settings: { column: 2 } })
    const c = blk('text', { settings: { column: 3 } })
    const outsider = blk('text')
    const rows = layout([a, b, c, outsider])
    expect(rows[0]).toHaveLength(3)

    // Тащит участник ряда — и получает ту же границу ряда, что и всякий пришелец.
    expect(pick([a, b, c, outsider], b.id, a.id)).toEqual({
      afterId: c.id,
      lineIds: [b.id, c.id],
      before: false,
    })
    // Тот же указатель, но тащат СНАРУЖИ — граница ряда со всем его составом.
    expect(pick([a, b, c, outsider], b.id, outsider.id)).toEqual({
      afterId: c.id,
      lineIds: [a.id, b.id, c.id],
      before: false,
    })
  })

  // ЖАЛОБА ВЛАДЕЛЬЦА 2026-08-12: «если в первой колонке один блок, а во второй
  // несколько, то чтобы вытащить блок из колонки в свой ряд, нужно навестись именно на
  // последний блок второй колонки — это очень неочевидно». Причиной была щель внутри
  // чужой стопки, полагавшаяся участнику ряда: она занимала верхнюю половину ряда. Без
  // неё у ряда одна цель, она начинается у нижнего края его содержимого и держится по
  // всей ШИРИНЕ — целиться в последний блок больше не нужно, довольно его высоты.
  it('короткая колонка рядом со стопкой: «под рядом» ловится на любой ширине', () => {
    const left = blk('short_text')
    const r1 = blk('email', { settings: { column: 2 } })
    const r2 = blk('phone', { settings: { column: 2 } })
    const below = blk('text')
    const blocks = [left, r1, r2, below]
    const rows = layout(blocks)
    expect(rows[0]).toHaveLength(2)
    const boxes = boxesOf(rows)
    const opts = { layer: 'unit' as const, activeId: left.groupId }
    const under = { afterId: r2.id, lineIds: [r1.id, r2.id], before: false }

    // Тащим единственный блок левой колонки. На высоте ПОСЛЕДНЕГО блока правой цель
    // одна и та же — и над своей колонкой (где пусто), и над чужой.
    const y = boxes.get(r2.id)!.top + H / 2
    expect(pickDropTarget(rows, boxes, { x: 40, y }, opts)).toEqual(under)
    expect(pickDropTarget(rows, boxes, { x: W - 40, y }, opts)).toEqual(under)
    // Выше — ряд ещё не кончился, и щели в нём нет ни для кого.
    expect(pickDropTarget(rows, boxes, { x: 40, y: boxes.get(r1.id)!.top + H / 2 }, opts)).toBeNull()
  })

  it('колонку выбирает X указателя', () => {
    const { left, right } = section()
    const below = blk('text')
    const rows = layout([left, right, below])
    const boxes = boxesOf(rows)
    const y = boxes.get(left.id)!.top + H / 2

    const atLeft = pickDropTarget(rows, boxes, { x: 40, y }, { layer: 'part', inner: INNER, activeId: right.id })
    const atRight = pickDropTarget(rows, boxes, { x: W - 40, y }, { layer: 'part', inner: INNER, activeId: left.id })
    expect(atLeft?.afterId).toBe(left.id)
    expect(atRight?.afterId).toBe(right.id)
  })

  it('просвет ПОД рядом принадлежит ряду, а не колонке под ним', () => {
    const { left, right } = section()
    const below = blk('text')
    const rows = layout([left, right, below])
    const boxes = boxesOf(rows)
    const y = boxes.get(left.id)!.bottom + GAP_ROW / 2

    const t = pickDropTarget(rows, boxes, { x: 40, y }, { layer: 'part', inner: INNER, activeId: below.id })
    expect(t).toEqual({ afterId: right.id, lineIds: [left.id, right.id], before: false })
  })

  // Порт сценария, которым прежде проверялся rowBoundaryTarget: исключение «свой ряд»
  // обязано быть именно СВОИМ. Участник верхнего ряда для нижнего такой же чужак, как
  // всякий одиночка, и щель нижнего ему не полагается.
  it('участник ВЕРХНЕГО ряда не роняет блок в щель нижнего', () => {
    const a = blk('short_text')
    const b = blk('email', { settings: { column: 2 } })
    const c = blk('phone')
    const d = blk('number', { settings: { column: 2 } })
    const rows = layout([a, b, c, d])
    expect(rows).toHaveLength(2)
    expect(rows[1]).toHaveLength(2)

    // b из верхнего ряда целится в c — левого участника нижнего.
    expect(pick([a, b, c, d], c.id, b.id)).toEqual({
      afterId: d.id,
      lineIds: [c.id, d.id],
      before: false,
    })
  })

  // Полоса цели кончается у следующего элемента ЕЁ КОЛОНКИ, а не полотна: у секции
  // колонки разной высоты, и под короткой лежит пустое место — там указатель ни на чём
  // не стоит, значит граница ряда своё право на него не теряет.
  it('пустое место под КОРОТКОЙ колонкой секции остаётся за границей ряда', () => {
    const caption = blk('title', { groupId: 'q' })
    const field = blk('short_text', { groupId: 'q' })
    const short = blk('text', { settings: { column: 2 } })
    const outsider = blk('text')
    const blocks = [caption, field, short, outsider]
    const rows = layout(blocks)
    expect(rows[0]).toHaveLength(2)
    const boxes = boxesOf(rows)
    // Указатель в правой (короткой) колонке, но на высоте ВТОРОЙ строки левой.
    const at = { x: boxes.get(short.id)!.left + 10, y: boxes.get(field.id)!.top + H / 2 }

    expect(pickDropTarget(rows, boxes, at, { layer: 'part', inner: INNER, activeId: outsider.id })).toEqual({
      afterId: short.id,
      lineIds: [caption.id, field.id, short.id],
      before: false,
    })
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

  // Правило проверяется НАБОРОМ целей, но обещано оно про результат: пока правило было
  // подменой постфактум, у него был тест «после дропа ряд остался прежним составом», и с
  // переездом правила такой сторож не должен пропасть. Здесь обе половины сведены:
  // адрес называет полотно, исполняет его стор, а спрашивается с них раскладка.
  it('адрес, названный полотном, оставляет ряд прежним составом', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text') // одиночка НАД рядом — его и потащим
    store.getState().addBlock('short_text') // левый участник
    store.getState().addBlock('email') // правый участник
    const [txt, left, right] = store.getState().blocks
    store.getState().placeInRow(right!.groupId, left!.groupId, 2, true)

    const blocks = store.getState().blocks
    const rows = layout(blocks)
    expect(rows[1]).toHaveLength(2) // [одиночка], [левый | правый]
    const boxes = boxesOf(rows)

    // Целимся в ЛЕВУЮ колонку: прежде это была та самая сырая цель, от которой группа
    // вставала МЕЖДУ колонками и пересобирала ряд новым составом.
    const t = pickDropTarget(rows, boxes, on(boxes, left!.id), {
      layer: 'unit',
      activeId: txt!.groupId,
    })
    expect(t).toEqual({ afterId: right!.id, lineIds: [left!.id, right!.id], before: false })

    store.getState().reorderGroups(txt!.groupId, blocks.find((b) => b.id === t!.afterId)!.groupId)

    const after = store.getState().blocks
    expect(after.map((b) => b.type)).toEqual(['short_text', 'email', 'text'])
    expect(packRows(groupBlocks(after)).map((r) => r.length)).toEqual([2, 1])
  })

  // ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ — ЩЕЛЬ ВНУТРИ КОЛОНКИ (владелец, 2026-08-13; ADR §10 «Щель
  // внутри колонки»): такая цель несёт номер, и команда бит не снимает. Даёт её колонка,
  // в которую указатель ПОПАЛ по горизонтали, — и «свой» участник ряда от пришельца
  // снаружи здесь ничем не отличается.
  //
  // Стопка из ТРЁХ, а не из двух: вычеркнув активного, в стопке из двух остаётся один
  // живой участник, он же последний, — щели там нет по построению, её место у границы
  // ряда. Тест на двух прошёл бы при любой реализации.
  describe('щель внутри колонки', () => {
    const stack = () => ({
      a: blk('short_text', { settings: { column: 1 } }),
      b: blk('email', { settings: { column: 1 } }),
      c: blk('phone', { settings: { column: 1 } }),
      d: blk('number', { settings: { column: 2 } }),
    })

    it('пришелец снаружи ряда встаёт МЕЖДУ участниками колонки', () => {
      const { a, b, c, d } = stack()
      const outsider = blk('text')
      const blocks = [a, b, c, d, outsider]
      expect(layout(blocks)[0]).toHaveLength(2)

      // Одиночка из-под ряда целится в первого участника стопки — и получает место в её
      // середине, а не «под всем рядом».
      expect(pick(blocks, a.id, outsider.id)).toEqual({
        afterId: a.id,
        lineIds: [a.id],
        before: false,
        column: 1,
      })
      // Тот же ответ соседу по секции: «свой» и «чужой» здесь не различаются, различает
      // только попадание указателя в колонку.
      expect(pick(blocks, a.id, d.groupId, 'unit')).toEqual({
        afterId: a.id,
        lineIds: [a.id],
        before: false,
        column: 1,
      })
    })

    it('участник стопки целится в своего соседа — линия в ширину КОЛОНКИ', () => {
      const { a, b, c, d } = stack()
      const blocks = [a, b, c, d]
      expect(layout(blocks)[0]).toHaveLength(2)

      // Тащим c (третий в своей колонке), указатель на a — первом её живом участнике.
      expect(pick(blocks, a.id, c.id)).toEqual({
        afterId: a.id,
        lineIds: [a.id],
        before: false,
        column: 1,
      })
      // Групповой слой отвечает то же самое: правило про колонку, а не про слой.
      expect(pick(blocks, a.id, c.groupId, 'unit')).toEqual({
        afterId: a.id,
        lineIds: [a.id],
        before: false,
        column: 1,
      })
    })

    it('после ПОСЛЕДНЕГО живого участника колонки — по-прежнему граница ряда', () => {
      const { a, b, c, d } = stack()
      const blocks = [a, b, c, d]

      // b — последний живой в колонке, раз c уехал: тут «вытащить вниз, во всю ширину».
      const t = pick(blocks, b.id, c.id)
      expect(t).toEqual({ afterId: d.id, lineIds: [a.id, b.id, d.id], before: false })
      expect(t?.column).toBeUndefined()
    })

    // ЖАЛОБА 2026-08-12 ЦЕЛА, и держится она на ПОПАДАНИИ: снаружи колонки её щелей нет,
    // сколько бы ни была она ближайшей. Иначе автор, тянущий свой единственный блок вниз
    // по своей (уже опустевшей) половине, снова всю дорогу видит линию внутри чужой
    // стопки вместо «под рядом».
    it('снаружи колонки её щелей нет, даже когда она ближайшая', () => {
      const alone = blk('short_text', { settings: { column: 1 } })
      const r1 = blk('email', { settings: { column: 2 } })
      const r2 = blk('phone', { settings: { column: 2 } })
      const r3 = blk('number', { settings: { column: 2 } })
      const rows = layout([alone, r1, r2, r3])
      expect(rows[0]).toHaveLength(2)
      const boxes = boxesOf(rows)
      const opts = { layer: 'unit' as const, activeId: alone.groupId }

      // Курсор в ЛЕВОЙ половине: своя колонка опустела, ближайшей стала чужая стопка.
      for (const id of [r1.id, r2.id]) {
        const y = boxes.get(id)!.top + H / 2
        expect(pickDropTarget(rows, boxes, { x: 40, y }, opts)).toBeNull()
      }
      // На высоте последнего блока стопки — «под рядом», во всю ширину, как и было.
      expect(pickDropTarget(rows, boxes, { x: 40, y: boxes.get(r3.id)!.top + H / 2 }, opts))
        .toEqual({ afterId: r3.id, lineIds: [r1.id, r2.id, r3.id], before: false })
      // А стоит увести курсор В стопку — и её щель называется: попадание, а не близость.
      expect(pickDropTarget(rows, boxes, { x: W - 40, y: boxes.get(r1.id)!.top + H / 2 }, opts))
        .toEqual({ afterId: r1.id, lineIds: [r1.id], before: false, column: 2 })
    })

    it('ряд из одной колонки щелей не даёт: секции нет — нечего и сохранять', () => {
      const a = blk('short_text')
      const b = blk('email')
      const c = blk('phone')

      expect(pick([a, b, c], a.id, c.id)?.column).toBeUndefined()
    })
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
