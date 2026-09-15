import { choiceIssues } from './choice'
import { type BlockKindContract } from './contract'

// Теги — несколько вариантов из выпадающего списка. От multi_choice отличается ТОЛЬКО
// контролом (поле с плашками и поиском против флажков на виду): та же модель опций, тот
// же ответ — массив id. Поэтому и семья, и кардинальность, и правила у него те же.
export const multiSelect: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['options'],
  supportsPlaceholder: false,
  requiresCaption: true,
  choice: 'multi',
  issues: choiceIssues,
}
