import { type BlockKindContract } from './contract'

// Телефон. Проверяется мягко (допустимые символы и число цифр, а не формат страны) —
// правило живёт в валидации ответа, isValidPhone.
export const phone: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: true,
  requiresCaption: false,
}
