import { type BlockKindContract } from './contract'

// Заголовок РАЗДЕЛА формы. Контент, а не подпись: в группу вопроса не входит никогда
// (раздел — не подпись поля), ответа не собирает.
export const heading: BlockKindContract = {
  family: 'content',
  carriesText: true,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
