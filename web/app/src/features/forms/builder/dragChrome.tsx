import { useDroppable } from '@dnd-kit/core'
import { type Dispatch, type ReactNode, type SetStateAction } from 'react'

// ВИД ЖЕСТА — один на все слои перетаскивания полотна: строки и вопросы (SlashEditor),
// варианты choice-блока (BlockRow). Отклика ровно три (EDITOR.md §5): линия вставки
// говорит МЕСТО, гост источника — откуда элемент взяли, полоса зоны — что сделает
// отпускание. Пока модуля не было, слой вариантов жил своей механикой (dnd-kit со
// своим расступанием), и «одинаковый жест» держался только на памяти правящего.
//
// Слоёв касается ТОЛЬКО вид и замер. Правила («какая цель под указателем», «у какого
// ряда горит приглашение») у каждого слоя свои и живут в своих чистых модулях —
// dropTarget.ts/rowZones.ts у полотна, optionDrop.ts у вариантов.

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
// «встанешь в эту колонку», линия во всю ширину — «встанешь между рядами». Половина
// просвета (gap) ставит её ровно посередине между соседями — так же, как её ставит глаз,
// когда решает, «куда это упадёт». Просвет у слоёв разный: 28px между вопросами, 12px
// между вариантами, — поэтому он приходит аргументом.
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

// DropLine — сама линия. Позиционирование ПРЯМОЕ, без своей анимации: rAF-замер и так
// даёт гладкие значения, а пружина, ретаргетируемая каждый кадр, копила скорость по
// движущейся цели и отскакивала на остановке (урок снятой драг-рамки, EDITOR.md §5).
export function DropLine({ rect }: { rect: Rect }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 z-20 rounded-full bg-primary"
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }}
    />
  )
}

// SourceSlot — место госта источника. Ширину задаём измеренную, высоту — нет: копия
// рисуется тем же компонентом, что и оригинал, и своя высота у неё честнее округлённой
// чужой.
export function SourceSlot({ rect, children }: { rect: Rect; children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0"
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w }}
    >
      {children}
    </div>
  )
}

// GhostFrame — вид тусклой копии. Копия на полотне ОДНА: гост источника (слот, из
// которого элемент вынули). Дублёра на будущем месте нет, и вернуть его нельзя, не
// вернув подвижную раскладку (EDITOR.md §5.2).
//
// Содержимое рисует вызывающий — тем же компонентом, которым элемент показан в покое:
// копия обязана выглядеть результатом, а не эскизом. Пунктирная рамка — absolute-оверлей
// поверх, чтобы копия не занимала лишних пикселей и не сдвигала ряд.
export function GhostFrame({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden="true" className="pointer-events-none relative select-none opacity-50">
      <span className="absolute -inset-2 rounded-lg border border-dashed border-primary bg-primary/5" />
      <div className="relative">{children}</div>
    </div>
  )
}

// Зона жеста — полоса СНАРУЖИ контента, в поле контейнера, за рейлом (решение владельца
// 2026-08-02). Внутри строки её быть не должно: жест кладёт элемент РЯДОМ со строкой, и
// зона внутри значила бы целиться в текст, который никуда не переезжает.
//
// Три числа, и все три зеркалят рейл группы (GroupRow): рейл жеста стоит на том же вылете
// (RAIL_OUT = 8px, класс -left-2/-right-2), зона начинается за ним (ZONE_GAP) и тянется до
// края поля (px-20 = 80px; на узком экране поле 20px, но кабинет desktop-first).
// Ширина зоны = 80 − 8 − 2 = 70px.
const ZONE_LEFT = 'right-full mr-2.5 w-2 sm:w-[4.375rem]'
const ZONE_RIGHT = 'left-full ml-2.5 w-2 sm:w-[4.375rem]'
// Рейл жеста — те же координаты и та же толщина, что у рейла группы: у автора не должно
// быть двух «почти одинаковых» линий на разном вылете.
const zoneRail = (side: 'left' | 'right', hot: boolean) =>
  `pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 rounded-full bg-primary transition-opacity ${
    side === 'right' ? '-right-2' : '-left-2'
  } ${hot ? 'opacity-100' : 'opacity-40'}`
// Площадь зоны БЕЗ заливки. Бокс остаётся: dnd-kit меряет прямоугольник droppable'а, и
// зона без него перестала бы ловить курсор вовсе.
const zoneHit = 'pointer-events-none absolute inset-y-0 z-10 rounded-md'
// Заливка зоны — ТУСКЛЕЕ рейла всегда: рейл называет место, заливка — площадь, в которую
// надо попасть. Под курсором наливаются обе, но порядок яркости сохраняется.
//
// Осталась она только у БОКОВЫХ зон — внешних границ ряда и зоны второго уровня (решение
// владельца 2026-08-12). Они лежат в поле контейнера, где кроме них ничего нет, и площадь
// там надо чем-то назвать. Внутренние (жёлоб между колонками, подвал колонки) заливку
// потеряли: они ложатся ВПЛОТНУЮ к контенту, и подсвеченный прямоугольник поверх формы
// читался как «эта часть формы что-то значит».
export const zoneFill = (hot: boolean) =>
  `${zoneHit} transition-colors ${hot ? 'bg-primary/20' : 'bg-primary/[0.07]'}`
export const ZONE_SIDE = { left: ZONE_LEFT, right: ZONE_RIGHT }

// SideDropZone — приглашение «открой здесь НОВУЮ колонку» на внешней границе ряда. Якорь
// — контейнер РЯДА, а не элемент: край элемента зависит от того, что внутри, а полоса
// ряда неподвижна (её края = края холста), и зона, привязанная к краю элемента, уехала бы
// из-под курсора при первом же изменении его ширины. Вне потока и pointer-events-none:
// dnd-kit меряет rect, а не ловит события, а занимающий место контрол схлопнул бы строку
// на mousedown (урок TD-22).
//
// id зоны считает ВЫЗЫВАЮЩИЙ: у каждого слоя своё пространство id, и путать их фильтру
// коллизий нельзя. `isOver` у dnd-kit не спрашивается ни одной зоной: зона перестала быть
// его `over` (иначе она гасит активному элементу трансформу, §5 решение 5), и «горит»
// приезжает пропом.
export function SideDropZone({
  id,
  side,
  railOff,
  hot,
}: {
  id: string
  side: 'left' | 'right'
  railOff: boolean
  hot: boolean
}) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <>
      {!railOff && <span aria-hidden="true" className={zoneRail(side, hot)} />}
      <div
        ref={setNodeRef}
        aria-hidden="true"
        className={`${zoneFill(hot)} ${ZONE_SIDE[side]}`}
      />
    </>
  )
}

// GapDropZone — та же команда на ВНУТРЕННЕЙ границе: полоса в жёлобе между колонками,
// открывающая новую колонку между ними. Снаружи ряда для этого есть поле контейнера,
// внутри — только жёлоб, поэтому зона садится на левый край своей колонки и сдвигается на
// половину себя влево: её площадь = сам жёлоб, ничей контент она не перекрывает.
//
// ВИДНА, ТОЛЬКО КОГДА ВЗЯТА (решение владельца 2026-08-12). Правило для обеих внутренних
// зон и оно об одном: «вижу подсказку» и «отпущу — упадёт сюда» обязаны быть ОДНИМ
// состоянием, иначе подсказка называет место, которого дроп в этот момент не делает.
// Приглашает боковая полоса (у неё логика своя, §5.1), внутренняя — отклик: загорелась,
// значит отпускай. Бокс при этом смонтирован ВСЕГДА и у всех колонок: несмонтированный
// droppable нечем поймать, и зона никогда бы не зажглась.
export function GapDropZone({ id, hot }: { id: string; hot: boolean }) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <>
      {hot && <span aria-hidden="true" className={`${zoneRail('left', true)} -left-3.5`} />}
      <div ref={setNodeRef} aria-hidden="true" className={`${zoneHit} -left-3.5 w-7 -translate-x-1/2`} />
    </>
  )
}

// FootDropZone — вторая команда ряда: «встань в СТОПКУ этой колонки». Полоса лежит в
// подвале колонки, поперёк, — горизонтальная там, где «новая колонка» вертикальная, и
// автору не нужно запоминать, какая полоса что делает: направление полосы и есть
// направление, в котором вырастет ряд.
//
// Живёт в жёлобе МЕЖДУ рядами, а не поверх контента: перекрыв низ колонки, она отбирала бы
// у вертикального дропа последний элемент колонки.
//
// Видна, только когда взята, — то же правило, что у GapDropZone, и по тому же доводу.
export function FootDropZone({ id, hot }: { id: string; hot: boolean }) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <>
      {hot && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -bottom-2 z-20 h-0.5 rounded-full bg-primary"
        />
      )}
      <div
        ref={setNodeRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-3.5 z-10 h-7 rounded-md"
      />
    </>
  )
}
