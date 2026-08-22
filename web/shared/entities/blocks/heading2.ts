import { type BlockKindContract } from './contract'

// Заголовок раздела второго уровня. От первого (heading) отличается ТОЛЬКО кеглем —
// свойства типа у трёх уровней одни и те же, поэтому файлы совпадают построчно.
// Сливать их в один тип с настройкой уровня нельзя: меню вставки выводится из реестра
// типов, и три пункта на один тип потребовали бы исключения ровно в том месте, ради
// которого реестр и делался.
export const heading2: BlockKindContract = {
  family: 'content',
  carriesText: true,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
