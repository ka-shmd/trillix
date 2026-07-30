import { type BlockKindContract } from './contract'

// Статический абзац — пояснение или инструкция. Внутри группы вопроса законен (он и
// есть тело вопроса, мост между подписью и полем), сам ответа не собирает.
export const text: BlockKindContract = {
  family: 'content',
  carriesText: true,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
