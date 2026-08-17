import { type Block } from '@entities/formSchema'
import { BlockControl } from '@fields/BlockField'

// FileControl — поле файла на полотне: та же зона, что увидит респондент.
//
// Загрузчик на полотне не подан (UploaderProvider ставит только рендерер), поэтому
// зона инертна: автор видит вид и лимиты, но файлы в черновик не грузятся.
export function FileControl({ block }: { block: Block }) {
  return <BlockControl block={block} />
}
