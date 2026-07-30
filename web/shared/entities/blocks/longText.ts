import { type BlockKindContract } from './contract'

// Длинный ответ — многострочный развёрнутый текст (textarea у респондента).
export const longText: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: true,
  requiresCaption: false,
}
