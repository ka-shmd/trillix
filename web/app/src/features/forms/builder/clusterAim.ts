import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

// ДИАГОНАЛЬ К ЗНАЧКАМ — кластер значков не гаснет, пока курсор, ушедший с носителя
// (строки, карточки варианта) влево, находится между его левым краем и кластером
// (решение владельца 2026-09-11). Зона — выпуклая оболочка левого края носителя и
// кластера: сверху её держит кластер, снизу — диагональ от нижнего левого угла носителя к
// значкам. Пока указатель в зоне, носитель помечен `data-aim`, и кластер по этой метке
// видим и ловит указатель так же, как по hover. Вышел из зоны — метка снята сразу.
// Стоящий в зоне курсор кластер держит: остановиться на полпути — законно.
//
// Зачем. Кластер стоит у ПЕРВОЙ строки носителя, а hover держится, только пока курсор
// над самим носителем. У длинного блока дорога снизу к значкам по диагонали идёт через
// пустое левое поле, и кластер гас на полпути. Оверлея у зоны нет — клики под ней
// доходят до своих целей (у правой колонки ряда там лежит соседняя). Отвергнутые
// варианты — JOURNAL, «Треугольник намерения у кластера значков».
//
// ⚠ Зона строится от КРАЯ НОСИТЕЛЯ, а не от точки выхода. Клин «от точки выхода к
// кластеру» у высокого носителя получается крутым и узким, и сама точка выхода в него не
// попадает: первый же pointermove после ухода снимал метку (JOURNAL, там же).
//
// ⚠ Пустое поле само кластер не зажигает по-прежнему (мина «кластер не зажигает сам
// себя», EDITOR.md §4): метка ставится только на уходе С носителя.
//
// Состояние живёт атрибутом на DOM, а не в React: курсор проезжает по полотну десятки
// строк в секунду, и setState на каждый уход перерисовывал бы их (TD-32).

export type Point = { x: number; y: number }
export type Box = { left: number; top: number; right: number; bottom: number }

// Запас вокруг кластера и края: рука ведёт не по линейке, и зона вплотную к углам
// отпускала бы курсор, чиркнувший мимо на пиксель. Правый край зоны заходит на PAD
// внутрь носителя — там курсор уже снова на нём, и держит обычный hover.
const PAD = 8
// Нижний угол зоны отнесён влево от носителя: без этого у низа высокого блока диагональ
// прижимается к его краю вплотную, и курсор, ушедший влево у самого низа, из зоны выпадал
// бы на первом пикселе.
const CORNER = 24

// aimZone — многоугольник зоны: оболочка левого края носителя (от верха до низа) и
// прямоугольника кластера, с запасом.
export function aimZone(carrier: Box, cluster: Box): Point[] {
  const top = Math.min(carrier.top, cluster.top) - PAD
  const bottom = carrier.bottom + PAD
  const edge = carrier.left + PAD
  return hull([
    { x: cluster.left - PAD, y: cluster.top - PAD },
    { x: cluster.left - PAD, y: cluster.bottom + PAD },
    { x: edge, y: top },
    { x: edge, y: bottom },
    { x: carrier.left - CORNER, y: bottom },
  ])
}

// hull — выпуклая оболочка (монотонная цепь Эндрю).
function hull(points: Point[]): Point[] {
  const ps = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const chain = (list: Point[]) => {
    const out: Point[] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) {
        out.pop()
      }
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...chain(ps), ...chain([...ps].reverse())]
}

// inZone — точка внутри многоугольника (чётность пересечений луча вправо).
export function inZone(p: Point, poly: Point[]): boolean {
  let inside = false
  let b = poly.at(-1)
  for (const a of poly) {
    if (b && a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
    b = a
  }
  return inside
}

// useClusterAim — обработчики для носителя кластера и ref для самого кластера. Метку
// носителя читает CSS: `group-data-[aim]:…` (у варианта — `group-data-[aim]/opt:…`).
export function useClusterAim() {
  const cluster = useRef<HTMLElement | null>(null)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])
  // Колбэк, а не объект: подходит к кластеру любого тега (div строки, кнопка-триггер).
  const clusterRef = useCallback((el: HTMLElement | null) => {
    cluster.current = el
  }, [])

  function onPointerLeave(e: ReactPointerEvent<HTMLElement>) {
    // Зажатая кнопка — жест (драг, выделение текста): во время жеста полотно на
    // наведение не отвечает, и держать кластер незачем.
    if (e.buttons !== 0 || !cluster.current) return
    const box = cluster.current.getBoundingClientRect()
    if (box.width === 0) return
    stop.current?.()

    const carrier = e.currentTarget
    const zone = aimZone(carrier.getBoundingClientRect(), box)
    // Ушёл не в зону (вниз, вверх, вправо) — метку не ставим вовсе.
    if (!inZone({ x: e.clientX, y: e.clientY }, zone)) return
    function onMove(ev: PointerEvent) {
      if (!inZone({ x: ev.clientX, y: ev.clientY }, zone)) end()
    }
    function end() {
      window.removeEventListener('pointermove', onMove)
      carrier.removeAttribute('data-aim')
      stop.current = null
    }
    carrier.setAttribute('data-aim', '')
    window.addEventListener('pointermove', onMove, { passive: true })
    stop.current = end
  }

  // Вернулся на носитель или дошёл до кластера (он потомок носителя — вход в него это
  // pointerenter носителя): дальше кластер держит обычный hover.
  function onPointerEnter() {
    stop.current?.()
  }

  return { clusterRef, onPointerEnter, onPointerLeave }
}
