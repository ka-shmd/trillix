import { choiceIssues } from './choice'
import { type BlockKindContract } from './contract'

// Несколько из списка — флажки. Ответ: МАССИВ id выбранных вариантов (отсюда отдельная
// кардинальность 'multi'; ту же носят теги).
export const multiChoice: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['options'],
  supportsPlaceholder: false,
  requiresCaption: true,
  choice: 'multi',
  issues: choiceIssues,
}
