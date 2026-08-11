import { type Block } from '@entities/formSchema'
import { packGroupRows, type Row } from '@fields/groups'

// ПРАВИЛО ПРИЦЕЛИВАНИЯ (решение владельца 2026-08-11, отменяет выбор цели по центрам).
//
// **Цель — элемент под указателем, и линия всегда ПОД ним.** Половин нет, «над» не
// существует, направление драга ни на что не влияет. Полоса прицеливания элемента — от
// его верхнего края до верхнего края следующего, то есть **просвет под элементом
// принадлежит элементу**; отсюда и линия между рядами: 28px-жёлоб принадлежит ряду
// сверху.
//
// Что этим заменено и почему. Прежде цель выбирал `closestVertical` по ЦЕНТРАМ, а
// сторону выводил порядок документа (`before = ai > ti`, swap-семантика dnd-kit). Из
// этого росли все четыре жалобы на жест разом: целились центром ПЕРЕТАСКИВАЕМОГО
// элемента (у высокого блока это в сотне пикселей от курсора); линия вставала у КРАЯ
// цели, то есть в полблока от того места, куда автор смотрит; одна и та же точка
// указателя значила разное в зависимости от того, откуда элемент приехал; а «между»
// не существовало как позиция вовсе — был «блок, а сторону выведу сам».
//
// Здесь же лечится видимая часть TD-54: позиций у полотна столько же, сколько было, но
// каждая теперь НАЗЫВАЕТСЯ элементом, на который автор смотрит. «Внутрь вопроса» и
// «между вопросами» перестали быть неразличимыми не потому, что одну из них убрали, а
// потому, что выбор стал читаемым.
//
// Модуль чистый и с собственным тестом по той же причине, что и `rowZones.ts`: жест
// проверяется мышью, в vitest он не воспроизводится, и без сторожа правила ломались бы
// правкой соседнего кода молча.

type Group = { id: string; blocks: Block[] }

// Прямоугольник строки, ИЗМЕРЕННЫЙ вызывающим. DOM — не дело чистой функции, а живые
// rect'ы нужны потому же, почему их мерит `measureUnion`: во время драга активная
// строка едет за курсором трансформой, и layout-бокс про неё врёт.
export type Box = { top: number; bottom: number; left: number; right: number }

// Цель дропа — одна позиция, названная элементом, под которым встанет линия.
//
//   afterId — блок, ПОСЛЕ которого встанет активный элемент в порядке документа;
//             null значит «первым на полотне» (единственная позиция без элемента
//             сверху).
//   lineIds — строки, по union которых меряется линия. Ширина union'а и есть часть
//             сообщения: строки целого ряда дают линию во всю форму («встанешь между
//             рядами»), одна строка — линию в ширину её колонки («встанешь сюда»).
//             Флага «во всю ширину» поэтому нет: ширину называет сам состав.
//   before  — линия НАД union'ом. Верно только у позиции «первым»: примкнуть к нижнему
//             краю ей не к чему.
export type DropTarget = { afterId: string | null; lineIds: string[]; before: boolean }

// Слой драга задаёт ЛИСТ обхода, и только его: тащат вопрос — лист группа, тащат
// строку — лист блок. Правила полос и легальности у слоёв общие.
export type PickOpts = { layer: 'block' | 'group'; activeId: string }

// pickDropTarget — цель под указателем. null значит «мерить нечего»: полотно пусто либо
// ни одна чужая строка не доехала до DOM.
//
// rows — раскладка полотна (`packRows`), boxes — измеренные строки по block-id.
export function pickDropTarget(
  rows: Row<Group>[],
  boxes: Map<string, Box>,
  pointer: { x: number; y: number },
  opts: PickOpts,
): DropTarget | null {
  // Активный элемент вычёркивается ВЕЗДЕ — и из адреса, и из состава линии. Причин две
  // и они разные. «После самого себя» не позиция вовсе: слот, который активный занимает
  // в раскладке, по праву принадлежит элементу СВЕРХУ, как и всякий просвет, — иначе
  // автор, потянувший строку чуть в сторону, целился бы в собственное пустое место.
  // А состав линии его не терпит потому, что меряется она по ЖИВОМУ DOM: активная
  // строка едет за курсором трансформой, и линия, измеренная вместе с ней, растянулась
  // бы до указателя.
  const ctx: Ctx = { boxes, active: new Set(activeBlockIds(rows, opts)), opts }

  const measured: { row: Row<Group>; box: Box }[] = []
  for (const row of rows) {
    const box = rowUnion(ctx, row)
    if (box) measured.push({ row, box })
  }
  if (measured.length === 0) return null

  const first = measured[0]!
  // Выше первого ряда — «встать первым», единственная позиция, у которой элемента
  // сверху нет. Линия ложится НАД первым рядом, то есть в 48px-просвете под заголовком
  // формы: заголовок целью не делаем (он вне DndContext), а выглядит это одинаково.
  if (pointer.y < first.box.top) {
    return { afterId: null, lineIds: liveIds(ctx, rowBlocks(first.row)), before: true }
  }
  // Ряды не перекрываются и идут в порядке документа, поэтому ряд под указателем — это
  // последний, чей верх выше указателя.
  let hit = first
  for (const m of measured) if (pointer.y >= m.box.top) hit = m
  return pickInRow(ctx, hit.row, hit.box, pointer)
}

type Ctx = { boxes: Map<string, Box>; active: Set<string>; opts: PickOpts }

// pickInRow — цель внутри ряда. Здесь же живёт единственное правило ЛЕГАЛЬНОСТИ, и
// раньше оно было двумя подменами цели постфактум (`rowBoundaryTarget` на блочном слое,
// `rowBoundaryGroup` на групповом): **ряд атомарен для вертикальной вставки**.
//
// Причина правила прежняя и никуда не делась. Пришелец, вставший МЕЖДУ участниками
// ряда, приходит без бита колонки, а раскладчик читает список буквально: бит без
// компании гаснет, секция закрывается и собирается заново с новым составом — автор
// целился в щель, а поменял содержимое ряда. Поэтому позиция «между участниками» из
// набора целей просто ИСКЛЮЧЕНА, а не исправляется после выбора: полоса, которая её
// занимала, отдана границе ряда.
//
// Изменилось одно: подмена была НАПРАВЛЕННОЙ (сверху кладём под ряд, снизу — над), потому
// что arrayMove значил разное в зависимости от направления. У адреса «после такого-то»
// направления нет вовсе, и правило стало односложным: щель между участниками отдаёт
// полосу границе ряда, то есть позиции ПОД ним.
//
// Исключение то же, что и было: активный элемент — сам участник этого ряда. Тогда он
// биты не ломает (состав секции не меняется, меняется порядок), и щель между
// участниками — законная цель, ею участников и переставляют местами.
function pickInRow(
  ctx: Ctx,
  row: Row<Group>,
  rowBox: Box,
  pointer: { x: number; y: number },
): DropTarget {
  const ids = liveIds(ctx, rowBlocks(row))
  // Граница ряда: линия во всю его ширину, элемент встаёт ПОД рядом целиком.
  const afterRow: DropTarget = { afterId: ids[ids.length - 1] ?? null, lineIds: ids, before: false }
  // Просвет под рядом принадлежит РЯДУ, а не колонке, у которой он оказался снизу:
  // иначе у ряда из разновысоких колонок жёлоб под короткой обещал бы колонку, а
  // элемент вставал бы под всей секцией.
  if (pointer.y >= rowBox.bottom) return afterRow

  const cells: { groups: Group[]; box: Box }[] = []
  for (const cell of row) {
    let box: Box | null = null
    for (const g of cell) box = merge(box, union(ctx, g.blocks))
    if (box) cells.push({ groups: cell, box })
  }
  if (cells.length === 0) return afterRow
  // Колонку выбирает X — единственное место жеста, где горизонталь что-то значит.
  // Не «попадание», а БЛИЖАЙШАЯ: указатель гуляет по 28px-жёлобу между колонками и по
  // полю полотна снаружи, и «мимо всех» там штатное состояние, а не промах.
  const cell = nearest(cells, (c) => gap(pointer.x, c.box.left, c.box.right))
  const group = pickStacked(cell.groups, (g) => union(ctx, g.blocks)?.top, pointer.y)
  if (!group) return afterRow

  // «После этой группы» — легально только на хвосте ряда либо когда ряд из одного
  // участника (границ внутри у него нет вовсе, и разводить два ответа было бы разницей
  // без различия). Всё остальное — щель между участниками, её полоса у границы ряда.
  const gIds = liveIds(ctx, group.blocks)
  const afterGroup = (): DropTarget => {
    const tailOfRow = gIds[gIds.length - 1] === ids[ids.length - 1]
    if (tailOfRow || row.flat().length === 1) return afterRow
    if (!ownsRow(ctx, rowBlocks(row))) return afterRow
    return { afterId: gIds[gIds.length - 1]!, lineIds: gIds, before: false }
  }
  if (ctx.opts.layer === 'group') return afterGroup()

  // Блочный слой спускается на уровень ниже: у вопроса свои ряды (§6.6 «подпись | поле»),
  // и та же атомарность действует внутри него — щель МЕЖДУ участниками внутреннего ряда
  // рвёт его так же, как внешнего, и легализует её только активный из этого же ряда.
  const inner = packGroupRows(group.blocks).map((r) => r.flat())
  const innerHit = pickStacked(inner, (r) => union(ctx, r)?.top, pointer.y)
  if (!innerHit) return afterGroup()
  const innerIds = liveIds(ctx, innerHit)
  const tail = innerIds[innerIds.length - 1]
  if (tail === undefined || tail === gIds[gIds.length - 1]) return afterGroup()
  if (innerHit.length > 1 && !ownsRow(ctx, innerHit)) return afterRow
  return { afterId: tail, lineIds: innerIds, before: false }
}

// pickStacked — элемент стопки под указателем: элемент владеет полосой от своего верха
// до верха следующего, последний — до дна вмещающего. Один код на обе стопки полотна
// (группы в колонке ряда и внутренние ряды вопроса) — правило полосы у них одно.
function pickStacked<T>(items: T[], topOf: (item: T) => number | undefined, y: number): T | null {
  let hit: T | null = null
  for (const item of items) {
    const top = topOf(item)
    if (top === undefined) continue
    if (hit === null || y >= top) hit = item
  }
  return hit
}

// Активный элемент — участник этого ряда: тогда щели между его участниками легальны,
// потому что состав секции от перестановки не меняется.
const ownsRow = (ctx: Ctx, blocks: Block[]): boolean =>
  blocks.some((b) => b.id === ctx.opts.activeId || b.groupId === ctx.opts.activeId)

const rowBlocks = (row: Row<Group>): Block[] => row.flat().flatMap((g) => g.blocks)

const liveIds = (ctx: Ctx, blocks: Block[]): string[] =>
  blocks.filter((b) => !ctx.active.has(b.id)).map((b) => b.id)

// Блоки, которые едут за курсором и потому целями быть не могут.
function activeBlockIds(rows: Row<Group>[], opts: PickOpts): string[] {
  if (opts.layer === 'block') return [opts.activeId]
  for (const row of rows) {
    for (const g of row.flat()) if (g.id === opts.activeId) return g.blocks.map((b) => b.id)
  }
  return []
}

// Замеры идут на КАЖДОЕ движение указателя и по всему полотну, поэтому промежуточных
// массивов здесь нет: активный отсеивается на месте (§5.3 EDITOR.md — правила кадра
// драга; цена мусора на форме в двести блоков уже была измерена в TD-55).
function union(ctx: Ctx, blocks: Block[]): Box | null {
  let top = Infinity
  let bottom = -Infinity
  let left = Infinity
  let right = -Infinity
  for (const block of blocks) {
    if (ctx.active.has(block.id)) continue
    const b = ctx.boxes.get(block.id)
    if (!b) continue
    top = Math.min(top, b.top)
    bottom = Math.max(bottom, b.bottom)
    left = Math.min(left, b.left)
    right = Math.max(right, b.right)
  }
  return top === Infinity ? null : { top, bottom, left, right }
}

function rowUnion(ctx: Ctx, row: Row<Group>): Box | null {
  let box: Box | null = null
  for (const cell of row) for (const g of cell) box = merge(box, union(ctx, g.blocks))
  return box
}

const merge = (a: Box | null, b: Box | null): Box | null =>
  a === null || b === null
    ? (a ?? b)
    : {
        top: Math.min(a.top, b.top),
        bottom: Math.max(a.bottom, b.bottom),
        left: Math.min(a.left, b.left),
        right: Math.max(a.right, b.right),
      }

// Расстояние от точки до отрезка: ноль внутри, иначе промах в пикселях.
const gap = (v: number, lo: number, hi: number): number => Math.max(lo - v, v - hi, 0)

function nearest<T>(items: T[], distance: (item: T) => number): T {
  let best = 0
  let bestD = distance(items[0]!)
  for (let i = 1; i < items.length; i++) {
    const d = distance(items[i]!)
    if (d < bestD) {
      best = i
      bestD = d
    }
  }
  return items[best]!
}
