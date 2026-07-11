import { type BlockType } from '@entities/formSchema'

// Палитра типов блоков: порядок и человеческие подписи для семи типов MVP.
// Единственное место соответствия type → подпись; канвас и панель настроек берут
// подпись отсюда же, чтобы не разъезжаться.
export const BLOCK_TYPES: ReadonlyArray<{ type: BlockType; label: string }> = [
  { type: 'short_text', label: 'Короткий текст' },
  { type: 'long_text', label: 'Длинный текст' },
  { type: 'email', label: 'Email' },
  { type: 'number', label: 'Число' },
  { type: 'single_choice', label: 'Один из списка' },
  { type: 'multi_choice', label: 'Несколько из списка' },
  { type: 'date', label: 'Дата' },
]

export const blockTypeLabel = (t: BlockType): string =>
  BLOCK_TYPES.find((b) => b.type === t)?.label ?? t
