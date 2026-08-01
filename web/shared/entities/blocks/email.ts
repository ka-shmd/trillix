import { type BlockKindContract } from './contract'

// Email — адрес с проверкой формата. Сама проверка живёт не здесь, а в валидации
// ОТВЕТА (Go domain/answers.go и renderer/validation.ts): схема формы описывает поле,
// а не то, что респондент в него введёт.
export const email: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: true,
  requiresCaption: false,
}
