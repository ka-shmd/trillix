import { useDroppable } from '@dnd-kit/core'
import { type ReactNode } from 'react'

import { type Rect } from './dragMeasure'

// ВИД ЖЕСТА — один на все слои перетаскивания: строки и вопросы полотна (SlashEditor),
// варианты choice-блока (BlockRow). Отклика ровно три (EDITOR.md §5): линия вставки
// говорит МЕСТО, гост источника — откуда элемент взяли, полоса зоны — что сделает
// отпускание. Пока модуля не было, слой вариантов жил своей механикой dnd-kit, и
// «одинаковый жест» держался только на памяти правящего.
//
// Слоёв касается ТОЛЬКО вид и замер (`dragMeasure.ts`). Правила («какая цель под
// указателем», «у какого ряда горит приглашение») у каждого слоя свои и живут в своих
// чистых модулях — dropTarget.ts/rowZones.ts у полотна, optionDrop.ts у вариантов.

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
const zoneFill = (hot: boolean) =>
  `${zoneHit} transition-colors ${hot ? 'bg-primary/20' : 'bg-primary/[0.07]'}`
const ZONE_SIDE = { left: ZONE_LEFT, right: ZONE_RIGHT }

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
// gutter — ширина жёлоба слоя в пикселях: 28px между вопросами, 12px между вариантами
// (.rf-options в fields.css). Зона равна жёлобу и центрована на нём — числом, а не
// классом: у Tailwind произвольные значения статичны, а жёлоба два.
export function GapDropZone({ id, hot, gutter }: { id: string; hot: boolean; gutter: number }) {
  const { setNodeRef } = useDroppable({ id })
  const half = gutter / 2
  return (
    <>
      {hot && (
        <span
          aria-hidden="true"
          className={zoneRail('left', true)}
          style={{ left: -half, right: 'auto' }}
        />
      )}
      <div
        ref={setNodeRef}
        aria-hidden="true"
        className={`${zoneHit} -translate-x-1/2`}
        style={{ left: -half, width: gutter }}
      />
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
export function FootDropZone({ id, hot, gutter }: { id: string; hot: boolean; gutter: number }) {
  const { setNodeRef } = useDroppable({ id })
  const half = gutter / 2
  // Полоса — на том же вылете, что боковые рейлы (RAIL_OUT = 8px), но не дальше середины
  // жёлоба: в 12px-жёлобе списка вариантов вылет 8px прижал бы её к следующему ряду.
  return (
    <>
      {hot && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 z-20 h-0.5 rounded-full bg-primary"
          style={{ bottom: -Math.min(RAIL_OUT, half) }}
        />
      )}
      <div
        ref={setNodeRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 z-10 rounded-md"
        style={{ bottom: -half, height: gutter }}
      />
    </>
  )
}

const RAIL_OUT = 8

// CellDropZone — та же зона на строке подписи (§6.6 EDITOR.md): дроп собирает ряд ВНУТРИ
// вопроса. Вид и правила те же, что у SideDropZone, — жест один, уровень разный, и
// выглядеть они обязаны одинаково. Сторона всегда правая: пара внутри вопроса
// направленная (слева подпись, справа поле).
//
// Своей линии не рисует никогда: зона второго уровня живёт ТОЛЬКО в блочном драге (её
// зажигает поле, уносимое из своей мульти-группы), а в нём жёлоб пуст у всех — см.
// zoneRailOff в SlashEditor.
export function CellDropZone({ id, hot }: { id: string; hot: boolean }) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <div ref={setNodeRef} aria-hidden="true" className={`${zoneFill(hot)} ${ZONE_SIDE.right}`} />
  )
}
