import { type Dispatch, type SetStateAction } from 'react'

// ЗАМЕРЫ ЖЕСТА — арифметика оверлеев драга, общая для полотна и списка вариантов. Вид
// того, что по этим числам рисуется, — рядом, в `dragChrome.tsx`; разделены они потому,
// что модуль с компонентами и хелперами разом ломает fast refresh (правило линта
// react-refresh/only-export-components), а не по вкусу.

// Rect — прямоугольник в координатах КОНТЕЙНЕРА оверлеев (`root` у замеров): полотно
// меряет от холста, список вариантов — от своего .rf-options. Обе системы одинаковы по
// устройству: контейнер `relative` и без рамки.
export type Rect = { x: number; y: number; w: number; h: number }

// setRect — бэйл на эквивалентный прямоугольник: замер гонит rAF-цикл, и setState тем же
// значением каждый кадр перерисовывал бы полотно посреди драга впустую.
export function setRect(set: Dispatch<SetStateAction<Rect | null>>, next: Rect | null): void {
  set((p) =>
    p === next ||
    (p && next && p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h)
      ? p
      : next,
  )
}

// Как элемент слоя находится в DOM: атрибут-якорь замера. У строк полотна это
// data-block-id (BlockRow), у вариантов — data-option-id (OptionCard).
export type Anchor = 'data-block-id' | 'data-option-id'

const find = (root: HTMLElement, attr: Anchor, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[${attr}="${id}"]`)

// measureSlot — бокс СЛОТА, из которого элемент вынули: там стоит гост источника.
//
// Меряется НЕ getBoundingClientRect, и это суть функции. Перетаскиваемый элемент едет за
// курсором CSS-трансформом, поэтому его клиентский прямоугольник показывает, где он
// сейчас, а нам нужно, где он БЫЛ. `offsetLeft`/`offsetTop`/`offsetWidth` — величины
// лайаута, про трансформ они не знают ни у самого элемента, ни у его предков (у группы он
// тоже есть, когда тащат вопрос). Обход идёт по offsetParent, а не по родителям: смещение
// считается от ближайшего позиционированного предка, и сумма по этой же цепочке даёт
// координату в системе контейнера оверлеев.
//
// Замер каждый кадр, хотя двигать раскладку во время драга полотну нечем: расступание
// снято, дублёр снят. Это осознанная страховка ценой одного элемента в кадре — снимок,
// взятый однажды на старте, соврал бы молча, стоит чему-нибудь снова начать двигаться.
//
// pad — вертикальный внутренний отступ элемента, который в бокс входит, а в копию нет:
// у строки полотна это её py-1.5 (6px), у карточки варианта — ноль. Меняешь отступ
// строки — правь число у вызова.
export function measureSlot(
  root: HTMLElement,
  ids: string[],
  attr: Anchor,
  pad: number,
): Rect | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const id of ids) {
    const el = find(root, attr, id)
    if (!el) continue
    let x = 0
    let y = 0
    for (
      let n: HTMLElement | null = el;
      n !== null && n !== root;
      n = n.offsetParent as HTMLElement | null
    ) {
      x += n.offsetLeft
      y += n.offsetTop
    }
    top = Math.min(top, y)
    bottom = Math.max(bottom, y + el.offsetHeight)
    left = Math.min(left, x)
    right = Math.max(right, x + el.offsetWidth)
  }
  if (left === Infinity || top === Infinity) return null
  return { x: left, y: top + pad, w: right - left, h: Math.max(0, bottom - top - pad * 2) }
}

// measureUnion — union-rect элементов с данными id по ЖИВОМУ DOM: getBoundingClientRect
// учитывает трансформы, которыми едет активный элемент, а layout-бокс — нет. null —
// мерить нечего.
export function measureUnion(root: HTMLElement, ids: string[], attr: Anchor): Rect | null {
  if (ids.length === 0) return null
  const cr = root.getBoundingClientRect()
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const id of ids) {
    const el = find(root, attr, id)
    if (!el) continue
    const r = el.getBoundingClientRect()
    top = Math.min(top, r.top)
    bottom = Math.max(bottom, r.bottom)
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
  }
  if (left === Infinity || top === Infinity) return null
  return { x: left - cr.left, y: top - cr.top, w: right - left, h: bottom - top }
}

// measureLine — ЛИНИЯ ВСТАВКИ: горизонтальная черта в просвете у края цели, там, где
// элемент окажется после дропа (2026-08-11). Заменила расступание строк: раскладка стоит
// неподвижно, а место называет линия.
//
// Ширина — по ЦЕЛИ, а не по контейнеру, и это несёт смысл: линия во всю колонку значит
// «встанешь в эту колонку», линия во всю ширину — «встанешь между рядами». Линия обязана
// стоять посередине просвета — так же, как её ставит глаз, когда решает, «куда это
// упадёт», — и `gap` здесь именно ОТСТУП ОТ КРАЯ ЗАМЕРЕННОГО БОКСА до этой середины.
// Число зависит от слоя, поэтому приходит аргументом: у полотна бокс строки включает её
// py-1.5 с обеих сторон, боксы соседей смыкаются ровно посередине 12px просвета, и
// отступ нулевой; у списка карточка вертикальных отступов не имеет, и до середины того
// же 12px просвета остаётся 6px.
const LINE_H = 2
export function measureLine(
  root: HTMLElement,
  ids: string[],
  before: boolean,
  attr: Anchor,
  gap: number,
): Rect | null {
  const u = measureUnion(root, ids, attr)
  if (!u) return null
  return { x: u.x, y: (before ? u.y - gap : u.y + u.h + gap) - LINE_H / 2, w: u.w, h: LINE_H }
}
