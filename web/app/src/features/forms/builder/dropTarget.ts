import { type Block } from '@entities/formSchema'
import { packGroupRows, type Row } from '@fields/groups'

// ПРАВИЛО ПРИЦЕЛИВАНИЯ (решение владельца 2026-08-11, отменяет выбор цели по центрам).
//
// **Цель — элемент под указателем, и линия всегда ПОД ним.** Половин нет, «над» не
// существует, направление драга ни на что не влияет.
//
// **Полоса прицеливания цели начинается у верха ЯКОРЯ — того элемента, под которым
// ляжет линия, — и тянется до якоря следующей цели.** Это уточнение стоило отдельной
// итерации с владельцем и есть суть правила, а не его деталь. Для блочного драга якорь
// это сам блок, поэтому полоса совпадает со строкой. Для ГРУППОВОГО якорь — последняя
// строка вопроса, и потому «под этим вопросом» загорается, когда указатель дошёл до его
// последней строки, а не едва заехал на его заголовок. В первой редакции полоса группы
// начиналась от её верха, и владелец сразу это увидел: «подсказка появляется, как только
// я на группу навожусь».
//
// Отсюда же и просвет: он принадлежит цели, чей якорь выше, — 28px-жёлоб между рядами
// достаётся ряду сверху.
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
// каждая теперь НАЗЫВАЕТСЯ элементом, на который автор смотрит.
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

// Кандидат = цель плюс верх её якоря. Полоса кандидата тянется от `anchorTop` до
// `anchorTop` следующего; своего «низа» у полосы нет, поэтому просветы между элементами
// не достаются никому дважды и не остаются ничьими.
type Cand = DropTarget & { anchorTop: number }

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
  // в раскладке, по праву принадлежит цели СВЕРХУ, как и всякий просвет, — иначе автор,
  // потянувший строку чуть в сторону, целился бы в собственное пустое место. А состав
  // линии его не терпит потому, что меряется она по ЖИВОМУ DOM: активная строка едет за
  // курсором трансформой, и линия, измеренная вместе с ней, растянулась бы до указателя.
  const ctx: Ctx = { boxes, active: new Set(activeBlockIds(rows, opts)), opts }

  const cands: Cand[] = []
  let firstRowIds: string[] | null = null
  for (const row of rows) {
    const ids = liveIds(ctx, rowBlocks(row))
    if (ids.length === 0) continue
    if (firstRowIds === null) firstRowIds = ids
    collectRow(ctx, row, ids, pointer.x, cands)
  }
  if (firstRowIds === null) return null

  // Цель под указателем — та, чей якорь ПОСЛЕДНИЙ из начавшихся выше него. Сравнение по
  // координате, а не по порядку в списке: в секции порядок документа колоночный (§13
  // EDITOR.md), то есть с порядком сверху вниз не совпадает.
  //
  // Сравнение СТРОГОЕ, и это тай-брейк: у секции колонки начинаются на одной высоте,
  // поэтому якорь цели внутри колонки может совпасть с якорем границы ряда. Побеждает
  // тот, кто попал в список раньше, а раньше идёт более частная цель — «в эту колонку»
  // важнее, чем «под всей секцией», иначе колоночные позиции были бы недостижимы.
  let hit: Cand | null = null
  for (const c of cands) {
    if (c.anchorTop > pointer.y) continue
    if (hit === null || c.anchorTop > hit.anchorTop) hit = c
  }
  // Ни одна полоса ещё не началась — указатель выше первого якоря. Это «встать первым»,
  // единственная позиция, у которой элемента сверху нет: линия ложится НАД первым рядом,
  // то есть в 48px-просвете под заголовком формы.
  if (hit === null) return { afterId: null, lineIds: firstRowIds, before: true }
  return { afterId: hit.afterId, lineIds: hit.lineIds, before: hit.before }
}

type Ctx = { boxes: Map<string, Box>; active: Set<string>; opts: PickOpts }

// collectRow — цели, которые даёт ряд. Здесь же живёт единственное правило ЛЕГАЛЬНОСТИ,
// и раньше оно было двумя подменами цели постфактум (`rowBoundaryTarget` на блочном
// слое, `rowBoundaryGroup` на групповом): **ряд атомарен для вертикальной вставки**.
//
// Причина правила прежняя и никуда не делась. Пришелец, вставший МЕЖДУ участниками
// ряда, приходит без бита колонки, а раскладчик читает список буквально: бит без
// компании гаснет, секция закрывается и собирается заново с новым составом — автор
// целился в щель, а поменял содержимое ряда. Поэтому позиция «между участниками» из
// набора целей просто ИСКЛЮЧЕНА, а не исправляется после выбора: полосу, которая её
// занимала, забирает граница ряда.
//
// Изменилось одно: подмена была НАПРАВЛЕННОЙ (сверху кладём под ряд, снизу — над),
// потому что arrayMove значил разное в зависимости от направления. У адреса «после
// такого-то» направления нет вовсе, и правило стало односложным.
//
// Исключение то же, что и было: активный элемент — сам участник этого ряда. Тогда он
// биты не ломает (состав секции не меняется, меняется порядок), и щель между
// участниками — законная цель, ею участников и переставляют местами.
function collectRow(ctx: Ctx, row: Row<Group>, ids: string[], x: number, out: Cand[]): void {
  const tail = ids[ids.length - 1]!
  const ownRow = ownsRow(ctx, rowBlocks(row))
  const single = row.flat().length === 1

  // Колонку выбирает X — единственное место жеста, где горизонталь что-то значит. Не
  // «попадание», а БЛИЖАЙШАЯ: указатель гуляет по 28px-жёлобу между колонками и по полю
  // полотна снаружи, и «мимо всех» там штатное состояние, а не промах. Цели даёт только
  // выбранная колонка: иначе на одной высоте их оказалось бы столько, сколько колонок, а
  // Y между ними не рассудил бы.
  const cells: { groups: Group[]; box: Box }[] = []
  for (const cell of row) {
    let box: Box | null = null
    for (const g of cell) box = merge(box, union(ctx, g.blocks))
    if (box) cells.push({ groups: cell, box })
  }
  let anchor = tail
  if (cells.length > 0) {
    const cell = nearest(cells, (c) => gap(x, c.box.left, c.box.right))
    for (const group of cell.groups) {
      const gIds = liveIds(ctx, group.blocks)
      if (gIds.length === 0) continue
      const gTail = gIds[gIds.length - 1]!
      // Якорь границы ряда — последний элемент ТОЙ КОЛОНКИ, на которую смотрит указатель,
      // а не последний в порядке документа. Разница видна только у секции, и там она
      // решает: колонки начинаются на одной высоте, поэтому якорь «по документу» (он в
      // самой правой колонке) открывал бы полосу «под всей секцией» с самого верха ряда
      // и съедал бы позиции внутри левых колонок.
      anchor = gTail
      if (ctx.opts.layer === 'block') collectInsideGroup(ctx, group, gTail, out)
      // «После этой группы»: если группа замыкает ряд, это граница ряда — её добавит
      // строка ниже, во всю ширину. Иначе это щель между участниками, законная своему.
      if (gTail === tail) continue
      if (!single && !ownRow) continue
      push(ctx, out, { afterId: gTail, lineIds: gIds, before: false }, gTail)
    }
  }
  // Граница ряда: линия во всю его ширину, элемент встаёт ПОД рядом целиком. Адрес —
  // последняя строка ряда в порядке документа (туда он и приземлится), якорь — конец
  // колонки под указателем: просвет под ней и есть то место, где ряд кончился.
  push(ctx, out, { afterId: tail, lineIds: ids, before: false }, anchor)
}

// collectInsideGroup — позиции ВНУТРИ вопроса (только блочный слой). У вопроса свои ряды
// (§6.6 «подпись | поле»), и та же атомарность действует внутри него: щель МЕЖДУ
// участниками внутреннего ряда рвёт его так же, как внешнего, и легализует её только
// активный из этого же ряда. Хвост вопроса сюда не попадает — он граница группы и
// решается уровнем выше.
function collectInsideGroup(ctx: Ctx, group: Group, gTail: string, out: Cand[]): void {
  for (const inner of packGroupRows(group.blocks)) {
    const blocks = inner.flat()
    const innerIds = liveIds(ctx, blocks)
    const tail = innerIds[innerIds.length - 1]
    if (tail === undefined || tail === gTail) continue
    if (blocks.length > 1 && !ownsRow(ctx, blocks)) continue
    push(ctx, out, { afterId: tail, lineIds: innerIds, before: false }, tail)
  }
}

// Кандидат без измеренного якоря выбрасывается: полосы у него нет, а цель, которую
// нельзя показать, хуже отсутствующей.
function push(ctx: Ctx, out: Cand[], target: DropTarget, anchorId: string): void {
  const box = ctx.boxes.get(anchorId)
  if (box) out.push({ ...target, anchorTop: box.top })
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
