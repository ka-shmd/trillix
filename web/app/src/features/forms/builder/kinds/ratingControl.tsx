import { type Block } from '@entities/formSchema'
import { BlockControl } from '@fields/BlockField'

// RatingControl — рейтинг на полотне: живое превью звёзд, тот же rf-rating, что увидит
// респондент. Без FieldShell по той же причине, что у шкалы: подпись рисует строка
// заголовка выше.
export function RatingControl({ block }: { block: Block }) {
  return <BlockControl block={block} />
}
