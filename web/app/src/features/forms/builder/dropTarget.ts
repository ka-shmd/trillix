import { type Block } from '@entities/formSchema'
import { packGroupRows, type Row } from '@fields/groups'

// ПРАВИЛО ПРИЦЕЛИВАНИЯ (владелец, 2026-08-11; история — JOURNAL, «Прицеливание при
// перетаскивании»).
//
// **Цель — элемент под указателем, и линия всегда ПОД ним.** Половин нет, «над» не
// существует, направление драга ни на что не влияет.
//
// **Полоса прицеливания цели начинается у верха ЯКОРЯ** — того элемента, под которым
// ляжет линия, — и кончается у верха следующего элемента слоя (`Cand`). Якорь блочного
// драга это сам блок, поэтому полоса совпадает со строкой; якорь ГРУППОВОГО — последняя
// строка вопроса, поэтому «под этим вопросом» загорается у его хвоста, а не на
// заголовке. Просвет принадлежит цели, чей якорь выше: 28px-жёлоб между рядами достаётся
// ряду сверху.
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
//   before  — линия НАД union'ом. Верно только у позиции «первым»: примкнуть к нижнему
//             краю ей не к чему.
//
// Флага «во всю ширину» у цели НЕТ: ширину называет состав `lineIds`, а вертикальный
// дроп во всю ширину ВСЕГДА — бит колонки он снимает (§13, `planBlockDrop`). Собрать или
// переставить колонки можно только зоной ряда (§5.1), у неё своя команда.
export type DropTarget = { afterId: string | null; lineIds: string[]; before: boolean }

// Слой драга задаёт ЛИСТ обхода, и только его: тащат вопрос — лист группа, тащат
// строку — лист блок. Правила полос и легальности у слоёв общие.
export type PickOpts = { layer: 'block' | 'group'; activeId: string }

// Кандидат = цель плюс верх её якоря. Полоса начинается у `anchorTop` и кончается у
// ВЕРХА СЛЕДУЮЩЕГО ЭЛЕМЕНТА СЛОЯ — не у якоря следующей цели.
//
// Разница есть только там, где якорь элемента не совпадает с его верхом, то есть на
// ГРУППОВОМ слое: якорь вопроса — его последняя строка. Полоса, дотянутая до якоря
// следующего вопроса, накрыла бы и его заголовок, и «щель между A и B» горела бы уже на
// первой строке B. На заголовке цели нет вовсе: указатель стоит на вопросе, а не на
// щели, и полотну сказать нечего.
//
// `until` считается по КОЛОНКЕ под указателем (а у границы ряда — по следующему ряду):
// у секции колонки разной высоты, и под короткой лежит пустое место, где указатель ни
// на чём не стоит. Полоса, оборванная там верхом чужой строки из соседней колонки,
// оставила бы это место без цели.
type Cand = DropTarget & { anchorTop: number; until: number }

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

  // Первый проход — только живые строки рядов и ВЕРХ каждого ряда: полоса последней
  // цели ряда кончается там, где начинается ряд следующий (см. Cand), и знать это надо
  // до того, как разбирать ряд текущий.
  const live: string[][] = []
  const tops: number[] = []
  for (const row of rows) {
    const ids = liveIds(ctx, rowBlocks(row))
    live.push(ids)
    tops.push(ids.length === 0 ? Infinity : topOf(ctx, ids))
  }

  const cands: Cand[] = []
  let firstRowIds: string[] | null = null
  let firstRowTop = Infinity
  for (let i = 0; i < rows.length; i++) {
    const ids = live[i]!
    if (ids.length === 0) continue
    if (firstRowIds === null) {
      firstRowIds = ids
      firstRowTop = tops[i]!
    }
    // Верх СЛЕДУЮЩЕГО живого ряда: ниже него цели этого ряда не действуют.
    let next = Infinity
    for (let j = i + 1; j < rows.length && next === Infinity; j++) {
      if (live[j]!.length > 0) next = tops[j]!
    }
    collectRow(ctx, rows[i]!, ids, pointer.x, next, cands)
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
  // Ни одна полоса не началась — указатель выше всех якорей. Это «встать первым», но
  // только пока он выше и самого ПЕРВОГО ряда: линия ложится над ним, в 48px-просвете
  // под заголовком формы. Заехал на первый вопрос, но не дошёл до его якоря — это уже
  // не «первым», а «ни над какой щелью» (см. ниже).
  if (hit === null) {
    return pointer.y < firstRowTop
      ? { afterId: null, lineIds: firstRowIds, before: true }
      : null
  }
  // Полоса кончилась, а следующая ещё не началась: указатель стоит на элементе, но не
  // на том его месте, которое называет щель. Цели нет — и это ответ, а не пробел:
  // показать линию было бы обещанием дропа, которого автор не просил.
  if (pointer.y >= hit.until) return null
  return { afterId: hit.afterId, lineIds: hit.lineIds, before: hit.before }
}

// Верх набора строк.
function topOf(ctx: Ctx, ids: string[]): number {
  let top = Infinity
  for (const id of ids) {
    const box = ctx.boxes.get(id)
    if (box && box.top < top) top = box.top
  }
  return top
}

// Ближайший верх СТРОГО ниже якоря, иначе — низ ряда (верх следующего). Совпадение
// верхов штатное (колонки секции начинаются на одной высоте), поэтому строго.
function endOfStripe(tops: number[], anchorTop: number, rowEnd: number): number {
  let best = rowEnd
  for (const t of tops) if (t > anchorTop && t < best) best = t
  return best
}

// pickHoverGroup — вопрос, НАД КОТОРЫМ указатель. Второй ответ полотна о жесте, и с
// целью дропа он намеренно НЕ совпадает: у цели якорь — ХВОСТ вопроса (линия ложится под
// ним, §5.2), поэтому приглашение «встань в ряд», взятое от неё, загоралось бы только у
// последней строки вопроса. Колонку предлагают вопросу целиком, ждать хвоста незачем.
//
// Вопроса два и они разные: линия отвечает «куда встанет», приглашение — «над чем стою».
// Одно про щель между вопросами, другое про вопрос.
//
// Ближайший, а не «строго внутри»: между рядами 28px жёлоб, снаружи колонок — поле
// полотна, и «мимо всех» там штатное состояние. Меряется вертикаль, горизонталь только
// разводит колонки, стоящие на одной высоте.
export function pickHoverGroup(
  rows: Row<Group>[],
  boxes: Map<string, Box>,
  pointer: { x: number; y: number },
  opts: PickOpts,
): string | null {
  const ctx: Ctx = { boxes, active: new Set(activeBlockIds(rows, opts)), opts }
  let best: string | null = null
  let bestV = Infinity
  let bestH = Infinity
  for (const row of rows) {
    for (const cell of row) {
      for (const group of cell) {
        // Активный вычеркнут теми же двумя причинами, что и в целях: сам себе он не
        // сосед по ряду, а его живой rect уехал за курсором.
        const box = union(ctx, group.blocks)
        if (box === null) continue
        const v = gap(pointer.y, box.top, box.bottom)
        const h = gap(pointer.x, box.left, box.right)
        if (v < bestV || (v === bestV && h < bestH)) {
          best = group.id
          bestV = v
          bestH = h
        }
      }
    }
  }
  return best
}

type Ctx = { boxes: Map<string, Box>; active: Set<string>; opts: PickOpts }

// collectRow — цели, которые даёт ряд. Здесь же живёт единственное правило ЛЕГАЛЬНОСТИ:
// **ряд атомарен для вертикальной вставки**.
//
// Пришелец, вставший МЕЖДУ участниками ряда, приходит без бита колонки, а раскладчик
// читает список буквально: бит без компании гаснет, секция закрывается и собирается
// заново с новым составом — автор целился в щель, а поменял содержимое ряда. Поэтому
// позиция «между участниками» из набора целей просто ИСКЛЮЧЕНА, а не исправляется после
// выбора: полосу, которая её занимала, забирает граница ряда.
//
// ИСКЛЮЧЕНИЙ У ПРАВИЛА НЕТ, в том числе для участников самого ряда: вертикальный дроп
// РАСПУСКАЕТ секцию на любом адресе (§13, два теста в `store.test.ts`), а собирает и
// переставляет колонки только зона ряда. Ряд — одна цель для всех, и она начинается у
// нижнего края его содержимого.
function collectRow(
  ctx: Ctx,
  row: Row<Group>,
  ids: string[],
  x: number,
  rowEnd: number,
  out: Cand[],
): void {
  const tail = ids[ids.length - 1]!

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
    // Верхи элементов ВЫБРАННОЙ КОЛОНКИ: ими кончаются полосы её целей (`Cand`).
    const colTops: number[] = []
    for (const group of cell.groups) {
      if (ctx.opts.layer === 'group') {
        const box = union(ctx, group.blocks)
        if (box !== null) colTops.push(box.top)
        continue
      }
      for (const block of group.blocks) {
        if (ctx.active.has(block.id)) continue
        const box = ctx.boxes.get(block.id)
        if (box) colTops.push(box.top)
      }
    }
    for (const group of cell.groups) {
      const gIds = liveIds(ctx, group.blocks)
      if (gIds.length === 0) continue
      const gTail = gIds[gIds.length - 1]!
      // Якорь границы ряда — последний элемент ТОЙ КОЛОНКИ, на которую смотрит указатель,
      // а не последний в порядке документа: колонки секции начинаются на одной высоте, и
      // якорь «по документу» (он в самой правой колонке) открывал бы полосу «под всей
      // секцией» с верха ряда, съедая позиции внутри левых колонок.
      anchor = gTail
      if (ctx.opts.layer === 'block') collectInsideGroup(ctx, group, gTail, colTops, rowEnd, out)
    }
  }
  // Граница ряда: линия во всю его ширину, элемент встаёт ПОД рядом целиком. Адрес —
  // последняя строка ряда в порядке документа (туда он и приземлится), якорь — конец
  // колонки под указателем: просвет под ней и есть то место, где ряд кончился. Полоса
  // тянется до следующего РЯДА, а не до следующего элемента колонки: ниже её якоря в
  // ряду ничего своего уже нет, и пустое место под короткой колонкой принадлежит ей.
  push(ctx, out, { afterId: tail, lineIds: ids, before: false }, anchor, EMPTY, rowEnd)
}

// Полоса без «своих» верхов: кончается концом ряда и только им.
const EMPTY: number[] = []

// collectInsideGroup — позиции ВНУТРИ вопроса (только блочный слой). У вопроса свои ряды
// (§6.6 «подпись | поле»), и та же атомарность действует внутри него: щель МЕЖДУ
// участниками внутреннего ряда рвёт его так же, как внешнего, и легализует её только
// активный из этого же ряда. Хвост вопроса сюда не попадает — он граница группы и
// решается уровнем выше.
//
// Отдельной проверки «щель между участниками ВНУТРЕННЕГО ряда» здесь нет, потому что
// такой щели не бывает: `packGroupRows` пускает в ряд только пару «подпись + отвечаемое»
// (`groups.ts`), отвечаемый у группы один (`regroup`), и он группу замыкает — значит
// внутренний ряд из двоих всегда последний и уходит выше по `tail === gTail`.
function collectInsideGroup(
  ctx: Ctx,
  group: Group,
  gTail: string,
  colTops: number[],
  rowEnd: number,
  out: Cand[],
): void {
  for (const inner of packGroupRows(group.blocks)) {
    const blocks = inner.flat()
    const innerIds = liveIds(ctx, blocks)
    const tail = innerIds[innerIds.length - 1]
    if (tail === undefined || tail === gTail) continue
    push(ctx, out, { afterId: tail, lineIds: innerIds, before: false }, tail, colTops, rowEnd)
  }
}

// Кандидат без измеренного якоря выбрасывается: полосы у него нет, а цель, которую
// нельзя показать, хуже отсутствующей.
function push(
  ctx: Ctx,
  out: Cand[],
  target: DropTarget,
  anchorId: string,
  colTops: number[],
  rowEnd: number,
): void {
  const box = ctx.boxes.get(anchorId)
  if (box) {
    out.push({ ...target, anchorTop: box.top, until: endOfStripe(colTops, box.top, rowEnd) })
  }
}

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
