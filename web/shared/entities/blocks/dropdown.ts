import { choiceIssues } from './choice'
import { type BlockKindContract } from './contract'

// Выпадающий список. От single_choice отличается ТОЛЬКО контролом (нативный select
// против радиокнопок): та же модель опций, тот же формат ответа — id варианта строкой.
// Поэтому и семья, и кардинальность, и правила у него те же.
export const dropdown: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['options'],
  supportsPlaceholder: false,
  requiresCaption: true,
  choice: 'single',
  issues: choiceIssues,
}
