import { type BlockType } from '@entities/formSchema'
import { cn } from '@/lib/utils'

import { BLOCK_ICONS } from './blockIcons'

// Глиф типа блока — общий для полотна редактора, меню вставки, списка вопросов условной
// логики и шапки колонки в таблице ответов. Словарь «тип → глиф» и объяснение, почему он
// живёт в shared, — в blockIcons.ts.
//
// Размер задан ЗДЕСЬ, а не вызывающими: тип, нарисованный в меню одним кеглем, а в
// таблице другим, читается как два разных значка.
export function BlockTypeIcon({ type, className }: { type: BlockType; className?: string }) {
  const Icon = BLOCK_ICONS[type]
  return <Icon className={cn('size-4', className)} aria-hidden />
}
