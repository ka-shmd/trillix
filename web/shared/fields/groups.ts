import { type Block, isAnswerableType } from '@entities/formSchema'

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
// .rf-group (ритм внутри вопроса 14px против 28px между — этап 13.3); полотно
// редактора строит из этого же ту же вложенность (SlashEditor.groups).
export function groupBlocks<T extends { groupId: string }>(blocks: T[]): { id: string; blocks: T[] }[] {
  const out: { id: string; blocks: T[] }[] = []
  for (const b of blocks) {
    const last = out[out.length - 1]
    if (last && last.id === b.groupId) last.blocks.push(b)
    else out.push({ id: b.groupId, blocks: [b] })
  }
  return out
}

// Половинная группа: её отвечаемый блок несёт settings.width === 'half' (валидация
// пускает width только whitelist-типам, здесь достаточно самого ключа).
function groupIsHalf(blocks: { settings?: { width?: 'half' } }[]): boolean {
  return blocks.some((b) => b.settings?.width === 'half')
}

// Упаковка групп в ряды (спека §5): два ПОДРЯД идущих half-вопроса — один ряд,
// всё остальное — ряд из одного. Одинокая половина (пары нет) кладётся рядом из
// одного и рендерится во всю ширину: стор это состояние не сохраняет (авторазвод),
// но опубликованная схема формально может его нести — рендер обязан быть
// детерминирован и без дыр в полряда. Порядок документа не меняется. Единый
// раскладчик всех трёх поверхностей — поверх groupBlocks.
export function packRows<T extends { blocks: { settings?: { width?: 'half' } }[] }>(
  groups: T[],
): T[][] {
  const rows: T[][] = []
  // half, ждущий пару: следующий half замыкает ряд, всё прочее оставляет его одного.
  let pending: T | null = null
  for (const g of groups) {
    const half = groupIsHalf(g.blocks)
    if (pending) {
      if (half) {
        rows.push([pending, g])
        pending = null
        continue
      }
      rows.push([pending])
      pending = null
    }
    if (half) pending = g
    else rows.push([g])
  }
  if (pending) rows.push([pending])
  return rows
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
    const text = (b.text ?? '').trim()
    if (b.type === 'title') {
      if (text && !hasTitle.has(b.groupId)) {
        m.caption = b.text ?? ''
        hasTitle.add(b.groupId)
      }
    } else if (b.type === 'label') {
      if (text && !hasTitle.has(b.groupId) && !m.caption) {
        m.caption = b.text ?? ''
      }
    } else if (isAnswerableType(b.type)) {
      if (b.required) m.required = true
    }
  }
  return meta
}
