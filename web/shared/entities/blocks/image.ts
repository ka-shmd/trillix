import { type BlockKindContract } from './contract'

// Картинка на полотне формы (PNG/JPEG). Единственный тип со своим ключом объекта в
// бакете; собственного text не несёт (подпись картинки — отдельный блок рядом).
export const image: BlockKindContract = {
  family: 'content',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['imageKey'],
  supportsPlaceholder: false,
  requiresCaption: false,
}
