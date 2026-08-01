import { type BlockKindContract } from './contract'

// Число — количество, возраст, сумма. Ответ хранится СТРОКОЙ, как у всех: конвенция
// проекта (fields/README.md), иначе значимый нуль перестаёт отличаться от пустоты.
// Своих настроек (min/max/step) у типа пока нет — см. §9 спеки фазы 16.
export const numberField: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: true,
  requiresCaption: false,
}
