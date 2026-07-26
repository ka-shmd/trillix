import {
  type Block,
  type BlockType,
  COLUMN_RIGHT,
  canShareRow,
  isAnswerableType,
  plainText,
} from '@entities/formSchema'

// Метаданные группы для рендера (v2, фаза 8.7): подпись группы и признак
// обязательности её поля. Раскладчик блоков (FormView/PreviewPane) считает их один
// раз и раздаёт в BlockField: блок-подпись берёт required для звёздочки, поле —
// caption для aria. Зеркалит domain.groupCaptions в Go: title перебивает label,
// пустой текст не в счёт; required — если хоть одно поле группы обязательно.
export type GroupMeta = { caption: string; required: boolean }

// Раскладка блоков по группам в порядке потока: блоки одного вопроса несут общий
// groupId и идут подряд (regroup держит группу односвязной). Возвращает группы в
// порядке первого вхождения, внутри — блоки в исходном порядке. Единый источник
// разбиения для всех поверхностей: рендерер и превью оборачивают каждую группу в
// .rf-group (ритм внутри вопроса 14px против 28px между — этап 13.3), полотно
// редактора строит из этого же ту же вложенность (`SlashEditor.groups`), а стор
// раскладывает им же полотно, когда двигает группы целиком (`moveGroup`,
// `reorderGroups`, `placeInRow`).
export function groupBlocks<T extends { groupId: string }>(blocks: T[]): { id: string; blocks: T[] }[] {
  const out: { id: string; blocks: T[] }[] = []
  for (const b of blocks) {
    const last = out[out.length - 1]
    if (last && last.id === b.groupId) last.blocks.push(b)
    else out.push({ id: b.groupId, blocks: [b] })
  }
  return out
}

// Ядро упаковки в ряды (спека §5). Идём по потоку: элемент с битом 'right'
// присоединяется к последнему ряду, если тот ещё не полон (в нём ровно один
// участник) и оба участника умеют делить ряд; иначе открывает свой ряд — флаг
// инертен, а не невалиден (кросс-блочное условие не валидируется ни в Zod, ни в Go,
// иначе undo и промежуточные состояния драга ловили бы 422). «В ряду максимум
// двое» — не отдельное правило, а физика ячеек: полон = length === 1 занят.
//
// Порядок документа неприкосновенен: конкатенация рядов равна исходному списку.
// Один и тот же раскладчик пакует и группы (packRows), и варианты (packOptionRows) —
// одна модель на два слоя, как требует §5.1.
function packCells<T>(items: T[], isRight: (i: T) => boolean, shares: (i: T) => boolean): T[][] {
  const rows: T[][] = []
  for (const item of items) {
    const last = rows[rows.length - 1]
    if (isRight(item) && last?.length === 1 && shares(last[0]!) && shares(item)) last.push(item)
    else rows.push([item])
  }
  return rows
}

// Носитель бита ряда у группы — её отвечаемый блок (у подписи и контента бита нет:
// ряд — свойство вопроса). Группа без отвечаемого блока (секционный heading,
// одинокая картинка) партнёром по ряду быть не может — shares вернёт false.
type RowCell = { type: BlockType; settings?: { column?: typeof COLUMN_RIGHT } }

const groupIsRight = (blocks: RowCell[]): boolean =>
  blocks.some((b) => b.settings?.column === COLUMN_RIGHT)

// Экспортируется: полотно редактора спрашивает тем же предикатом, кому светить зону
// жеста, — чтобы «кому можно в ряд» жило в одном месте с упаковкой.
export const groupCanShareRow = (blocks: RowCell[]): boolean =>
  blocks.some((b) => isAnswerableType(b.type) && canShareRow(b.type))

// Упаковка групп в ряды: обёртка .rf-row достаётся только ряду из двоих, ряд из
// одного рендерится как раньше (лишний div не меняет вид, но шумит в DOM). Единый
// раскладчик всех трёх поверхностей — поверх groupBlocks.
export function packRows<T extends { blocks: RowCell[] }>(groups: T[]): T[][] {
  return packCells(
    groups,
    (g) => groupIsRight(g.blocks),
    (g) => groupCanShareRow(g.blocks),
  )
}

// Упаковка вариантов в ряды (спека §5.1) — тот же бит, тот же раскладчик. Whitelist
// здесь не нужен: карточка варианта делит ряд всегда (потолок ширины у неё тот же,
// что у короткого поля), поэтому shares — константа. У опций dropdown флаг инертен
// по другой причине: список живёт в нативном select и рядов не имеет вовсе.
export function packOptionRows<T extends { column?: typeof COLUMN_RIGHT }>(options: T[]): T[][] {
  return packCells(
    options,
    (o) => o.column === COLUMN_RIGHT,
    () => true,
  )
}

export function groupMeta(blocks: Block[]): Map<string, GroupMeta> {
  const meta = new Map<string, GroupMeta>()
  const hasTitle = new Set<string>()
  const get = (g: string): GroupMeta => {
    let m = meta.get(g)
    if (!m) {
      m = { caption: '', required: false }
      meta.set(g, m)
    }
    return m
  }
  for (const b of blocks) {
    const m = get(b.groupId)
    // Подпись группы уходит в aria-label контрола и в тизеры — то есть в текст, а не в
    // разметку (фаза 14). Богатый заголовок вопроса РИСУЕТ ContentBlock из спанов; здесь
    // нужна плоская строка.
    const flat = plainText(b.text)
    const text = flat.trim()
    if (b.type === 'title') {
      if (text && !hasTitle.has(b.groupId)) {
        m.caption = flat
        hasTitle.add(b.groupId)
      }
    } else if (b.type === 'label') {
      if (text && !hasTitle.has(b.groupId) && !m.caption) {
        m.caption = flat
      }
    } else if (isAnswerableType(b.type)) {
      if (b.required) m.required = true
    }
  }
  return meta
}
