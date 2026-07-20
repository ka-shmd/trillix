import { type Block, isAnswerableType } from '@entities/formSchema'

// Метаданные группы для рендера (v2, фаза 8.7): подпись группы и признак
// обязательности её поля. Раскладчик блоков (FormView/PreviewPane) считает их один
// раз и раздаёт в BlockField: блок-подпись берёт required для звёздочки, поле —
// caption для aria. Зеркалит domain.groupCaptions в Go: title перебивает label,
// пустой текст не в счёт; required — если хоть одно поле группы обязательно.
export type GroupMeta = { caption: string; required: boolean }

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
