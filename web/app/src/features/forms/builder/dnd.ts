import { type ClientRect, type CollisionDetection } from '@dnd-kit/core'
import { type AnimateLayoutChanges, type SortingStrategy } from '@dnd-kit/sortable'

// После дропа dnd-kit «доигрывает» layout-анимацию перетащенного элемента от его
// СТАРОЙ layout-позиции (useDerivedTransform меряет rect до перестановки): элемент
// отскакивает на прежнее место и заново едет к новому. У строк это маскировалось
// ремаунтом (блок после дропа обычно меняет группу-родителя), у групп артефакт
// был виден всегда. Отключаем на обоих слоях (GroupRow и BlockRow): дроп фиксирует
// элемент сразу там, где его бросили. Остальным элементам дефолт и так ничего не
// анимирует (defaultAnimateLayoutChanges срабатывает только при wasDragging).
export const noLayoutAnimation: AnimateLayoutChanges = () => false

// Порог активации перетаскивания (px). Ниже порога жест — КЛИК, и с фазы 16 клик по
// грипу открывает настройки блока (§4.1 спеки: тащим — драг, кликаем — настройки; так
// ведёт себя Notion). Поэтому число перестало быть настройкой одного сенсора: по нему
// же грип отличает свой клик от хвостового click'а после настоящего перетаскивания
// (браузер шлёт его по mouseup, и без проверки попап открывался бы после каждого
// драга). Два места с одним смыслом обязаны читать одну константу — разъехавшись, они
// дадут «иногда после переноса выскакивает меню», а это не воспроизводится по заказу.
export const DRAG_ACTIVATION_DISTANCE = 6

// closestVertical — выбор цели по ВЕРТИКАЛИ и только по ней. Заменяет closestCenter,
// который на полотне делает ряд практически недостижимой целью (найдено владельцем
// 2026-08-03: «блоки вокруг ряда склеиваются, расклеить не получается»).
//
// closestCenter меряет ЕВКЛИДОВО расстояние между центрами. Полноширинный блок стоит
// центром посреди холста, а участник ряда — центром своей полуколонки, то есть примерно
// в 182px вбок (холст 700, колонка 336, жёлоб 28). Для цели-участника эти 182px входят
// в расстояние всегда, и обычный блок выигрывает конкурс, даже когда он на сотню
// пикселей ДАЛЬШЕ по вертикали: √(100² + 0²) < √(0² + 182²). Отсюда всё, что видно
// глазами: место «между блоком и рядом» не выбирается, перенос через ряд перепрыгивает
// его целиком, а блок, который тянут к ряду, уходит внутрь следующего вопроса — его
// подпись полноширинная и потому «ближе».
//
// Вертикальная вставка — одномерная задача («где в порядке документа»), и горизонтали в
// ней нет вовсе. Колонку выбирают не эти коллизии, а зоны жеста (pointerWithin,
// SlashEditor) — им горизонталь как раз важна, и они спрашиваются отдельно.
export const closestVertical: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
}) => {
  // Через снимок: цикл ниже обходит ВСЕ droppable'ы полотна на каждое движение
  // указателя, и каждое `rect.top` — это чтение scroll-свойства (см. flatRect).
  const active = flatRect(collisionRect)
  const centerY = active.top + active.height / 2
  // Обычный цикл, а не flatMap: функция бежит на КАЖДОЕ движение указателя по всем
  // droppable'ам полотна, и промежуточный массив на каждый из них — мусор на ровном
  // месте (так же устроен и родной closestCenter).
  const collisions = []
  for (const droppableContainer of droppableContainers) {
    const raw = droppableRects.get(droppableContainer.id)
    if (!raw) continue
    const rect = flatRect(raw)
    collisions.push({
      id: droppableContainer.id,
      data: { droppableContainer, value: Math.abs(rect.top + rect.height / 2 - centerY) },
    })
  }
  return collisions.sort((a, b) => a.data.value - b.data.value)
}

// dropSide — с какой стороны цели окажется перетаскиваемый элемент. Ответ целиком в
// арифметике arrayMove, которой живут и reorderBlocks, и reorderGroups: индекс цели
// берётся в ИСХОДНОМ списке, а вставка идёт в список уже без активного. Поэтому перенос
// вниз по документу кладёт элемент ПОД цель, а вверх — НАД ней.
//
// Правило записано отдельно и проверено против самого стора (dnd.test.ts), потому что
// по нему рисуется линия дропа, а её ошибка не ловится ничем: линия, нарисованная
// всегда снизу, при переносе вверх спокойно показывала место, к которому не имела
// отношения (найдено владельцем 2026-08-02). `order` — список СВОЕГО слоя: блоки для
// блочного драга, группы для группового.
export function dropSide(order: string[], activeId: string, overId: string): 'above' | 'below' {
  const from = order.indexOf(activeId)
  const to = order.indexOf(overId)
  return from >= 0 && to >= 0 && to < from ? 'above' : 'below'
}

// ПЛОСКИЙ СНИМОК ПРЯМОУГОЛЬНИКА — самая дорогая находка разбора драга (TD-55).
//
// `ClientRect` у dnd-kit только выглядит структурой с числами: `top`/`bottom`/`left`/
// `right` — ГЕТТЕРЫ, и каждый зовёт `getScrollOffsets` по прокручиваемым предкам, то
// есть читает scroll-свойство. Обращение к `rect.top` выглядит как чтение числа, а
// стоит как замер, и ничто в коде об этом не напоминает.
//
// Умножается это на два обстоятельства. Стратегию dnd-kit зовёт ПО РАЗУ НА КАЖДЫЙ
// сортируемый элемент, а раскладка ряда внутри обходит ещё и весь массив. И главное:
// блочный слой — одна сортируемая вселенная, но `SortableContext` у каждой группы
// СВОЙ (иначе `li` группы читала бы контекст блоков вместо своего, §2 EDITOR.md),
// поэтому на сотне вопросов стратегию зовут из сотни контекстов, и у каждого свой
// массив `sortedRects` — с тем же содержимым и другой идентичностью.
//
// Отсюда правило: **кэш обязан быть по ПРЯМОУГОЛЬНИКУ, а не по массиву.** Объекты
// `ClientRect` у всех контекстов одни и те же (приезжают из общей `droppableRects`),
// поэтому WeakMap по ним переживает границу контекста, тогда как кэш по ссылке на
// массив на этой границе промахивается каждый раз. Замерено на форме из 199 блоков:
// одно перетаскивание — 5 283 164 чтения scroll-свойства; кэш по массиву не убрал ни
// одного (и потому не дал выигрыша), кэш по прямоугольнику оставляет по шесть чтений
// на прямоугольник на кадр.
//
// Снимок живёт РОВНО ОДИН КАДР: прокрутка между кадрами его обесценивает, а внутри
// кадра меняться ей негде.
type FlatRect = { top: number; bottom: number; left: number; right: number; width: number; height: number }

let flatCache = new WeakMap<ClientRect, FlatRect>()
let flatScheduled = false

export function flatRect(r: ClientRect): FlatRect {
  const hit = flatCache.get(r)
  if (hit) return hit
  const out = {
    top: r.top,
    bottom: r.bottom,
    left: r.left,
    right: r.right,
    width: r.width,
    height: r.height,
  }
  flatCache.set(r, out)
  if (!flatScheduled) {
    flatScheduled = true
    const drop = () => {
      flatCache = new WeakMap()
      flatScheduled = false
    }
    // В браузере кадр — правильная граница жизни снимка. В node-окружении (табличные
    // тесты раскладки) rAF нет вовсе, и там снимок живёт до конца текущей задачи:
    // тесты синхронны, а кэш, переживший задачу, стал бы враньём.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(drop)
    else queueMicrotask(drop)
  }
  return out
}

const NO_SCALE = { scaleX: 1, scaleY: 1 }

// Одна ли это вертикальная стопка: у двумерного полотна соседи по СПИСКУ бывают
// соседями по документу, но не по экрану (левая и правая колонки секции идут в
// документе подряд, а стоят бок о бок). Считаем колонку общей, если горизонтальные
// проекции перекрываются больше чем наполовину узкого из двух.
function sameColumn(a: FlatRect, b: FlatRect): boolean {
  const overlap = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  return overlap > Math.min(a.width, b.width) / 2
}

// canvasSorting — как расступаются строки, пока элемент тащат. Заменяет
// verticalListSortingStrategy, которая на полотне кладёт СТРОКУ НА СТРОКУ (найдено
// владельцем 2026-08-02: «вытаскиваем блок из ряда и двигаем по полотну — блоки под
// рядом наезжают на ряд; отпустишь — встают нормально»). Причина одна, и она про
// допущение, которого полотно не выполняет:
//
//   **Родная стратегия считает список одной вертикалью, где уходящий элемент
//   освобождает свою высоту.** На двумерном полотне это неверно: элемент, вынутый из
//   КОЛОНКИ ряда (секция §13 или пара «подпись | поле» внутри вопроса), не освобождает
//   по вертикали НИЧЕГО — ряд ровно той же высоты держит соседняя колонка. Строки ниже
//   всё равно поднимаются на его высоту и садятся прямо на ряд, из которого его
//   вынули. Тот же корень у второго проявления: в документе колонки идут подряд
//   (сперва вся левая, потом вся правая), поэтому «зазор» между последней строкой левой
//   и первой строкой правой отрицательный, и сдвиг на нём становится произвольным.
//
// Ответ — развести ДВЕ величины, которые родная стратегия считает одной и той же:
//
//   freed  — сколько вертикали отдаёт СТАРОЕ место. Не высота элемента, а разница между
//            его низом и низом того, кто остаётся в его ряду: держат ряд — не отдаёт
//            ничего.
//   needed — сколько вертикали нужно на НОВОМ месте: высота элемента плюс просвет.
//
// В обычном столбике они равны, и всё сводится к родному поведению. Различаются они
// ровно тогда, когда элемент вынимают из колонки ряда, — и тогда нужны обе: старое место
// не схлопывается (freed = 0), а новое обязано раскрыться (needed > 0). Считать одной
// величиной нельзя ни в какую сторону: взять высоту — строки ниже сядут на ряд, из
// которого элемент вынули; взять ноль — полотно вообще перестанет разъезжаться, и место
// дропа станет невидимым (обе ошибки владелец увидел глазами, 2026-08-02 и 08-03).
//
// Отсюда три группы строк, а не две (a — активный, o — цель):
//
//   вниз (a < o):  (a, o]  ← −freed          | > o  ← needed − freed
//   вверх (a > o): [o, a)  ← +needed         | > a  ← needed − freed
//
// Асимметрия не описка: строка между старым и новым местом видит ОДНУ правку (вырез или
// вставку), а строка за новым местом — обе. В обычном случае needed = freed, третья
// группа получает ноль, и правило вырождается в родное.
//
// Внутри каждой группы сдвиг ОДИН И ТОТ ЖЕ, поэтому взаимные просветы сохраняются точно
// и наложиться строки не могут ни при каком наборе высот и зазоров; на границах групп
// разница ровно равна тому, что там открывается или закрывается. Колонку при этом
// фильтровать не нужно и НЕЛЬЗЯ: ряд целиком стоит ниже точки вставки — значит и едет
// целиком, обеими колонками. Побочно чинится снос ритма: родная брала высоту активного,
// а зазор — каждой строки свой, из-за чего просветы 14/28 (ритм 13.3) перетасовывались
// по ходу драга, хотя ни одна строка не меняла соседей.
export const canvasSorting: SortingStrategy = ({
  rects,
  activeIndex,
  overIndex,
  index,
  activeNodeRect,
}) => {
  // Всё, что стратегия читает, идёт через снимок: её зовут по разу на каждый элемент
  // полотна, и на форме у потолка MAX_BLOCKS это тысячи вызовов за кадр.
  const activeRaw = rects[activeIndex] ?? activeNodeRect
  const overRaw = rects[overIndex]
  if (!activeRaw || !overRaw || activeIndex === overIndex) return null
  const active = flatRect(activeRaw)
  const over = flatRect(overRaw)

  // Сам активный: смещение до нового места. Формула dnd-kit — она про drop-анимацию и
  // клавиатурный перенос (под указателем элемент и так едет за курсором) и в раскладке
  // соседей не участвует.
  if (index === activeIndex) {
    return {
      x: 0,
      y:
        activeIndex < overIndex
          ? over.top + over.height - (active.top + active.height)
          : over.top - active.top,
      ...NO_SCALE,
    }
  }
  if (!rects[index]) return null

  const down = activeIndex < overIndex
  const { freed, needed } = room(rects, activeIndex, down)
  const shift = down
    ? index <= activeIndex
      ? 0
      : index <= overIndex
        ? -freed
        : needed - freed
    : index < overIndex
      ? 0
      : index < activeIndex
        ? needed
        : needed - freed
  return shift === 0 ? null : { x: 0, y: shift, ...NO_SCALE }
}

// room — «сколько отдаёт старое место» и «сколько нужно на новом», обе из живой
// раскладки.
//
// Сперва находится РЯД активного: соседи по ряду — те, кто пересекается с ним по
// вертикали, стоя в другой колонке (участник секции, поле рядом со своей подписью). Их
// низ и верх задают пролёт ряда, и от него, а не от самого элемента, отмеряется просвет
// до следующей строки: сосед по СПИСКУ у элемента в ряду — вторая колонка, она стоит
// вровень, и просвет по ней вышел бы то нулём, то высотой чужой колонки.
//
//   needed = высота элемента + просвет от ряда до ближайшей строки за ним. В обычном
//            столбике ряда нет, пролёт равен самому элементу, и получается привычное
//            «высота плюс просвет».
//   freed  = 0, пока в ряду кто-то опускается так же низко: ряд не становится ниже ни на
//            пиксель. Если активный был в ряду самым низким — ровно разница низов. Ряда
//            нет — отдаётся столько же, сколько нужно.
// Кэш на один вызов раскладки: dnd-kit зовёт стратегию по разу НА КАЖДЫЙ элемент, а
// ответ зависит только от (rects, activeIndex, down) — один и тот же для всех. Без кэша
// обход всех прямоугольников внутри повторялся бы столько раз, сколько на полотне строк,
// то есть каждый кадр драга стоил бы квадрата от длины формы. Ключ — ССЫЛКА на rects:
// SortableContext собирает массив мемоизированно и раздаёт всем элементам одну и ту же.
let roomCache: { rects: readonly (ClientRect | undefined)[]; activeIndex: number; down: boolean; out: Room } | null = null
type Room = { freed: number; needed: number }

function room(rects: readonly (ClientRect | undefined)[], activeIndex: number, down: boolean): Room {
  const hit = roomCache
  if (hit && hit.rects === rects && hit.activeIndex === activeIndex && hit.down === down) {
    return hit.out
  }
  const out = computeRoom(rects, activeIndex, down)
  roomCache = { rects, activeIndex, down, out }
  return out
}

function computeRoom(
  rects: readonly (ClientRect | undefined)[],
  activeIndex: number,
  down: boolean,
): Room {
  const active = flatRect(rects[activeIndex]!)
  const inRow = (r: FlatRect) =>
    !sameColumn(r, active) &&
    Math.min(r.top + r.height, active.top + active.height) > Math.max(r.top, active.top)

  let held = -Infinity
  let rowTop = active.top
  let rowBottom = active.top + active.height
  for (let i = 0; i < rects.length; i++) {
    const raw = rects[i]
    if (!raw || i === activeIndex) continue
    const r = flatRect(raw)
    if (!inRow(r)) continue
    held = Math.max(held, r.top + r.height)
    rowTop = Math.min(rowTop, r.top)
    rowBottom = Math.max(rowBottom, r.top + r.height)
  }

  // Ближайшая строка ЗА рядом: участники ряда пропускаются — они не «следующие», они
  // соседи по горизонтали.
  let mate: FlatRect | undefined
  for (let i = activeIndex + (down ? 1 : -1); i >= 0 && i < rects.length; i += down ? 1 : -1) {
    const raw = rects[i]
    if (!raw) continue
    const r = flatRect(raw)
    if (inRow(r)) continue
    mate = r
    break
  }
  const gap = !mate
    ? 0
    : Math.max(0, down ? mate.top - rowBottom : rowTop - (mate.top + mate.height))
  const needed = active.height + gap
  return {
    freed: held > -Infinity ? Math.max(0, active.top + active.height - held) : needed,
    needed,
  }
}
