import { choiceIssues } from './choice'
import { type BlockKindContract } from './contract'

// Один из списка — радиокнопки. Ответ: id выбранного варианта строкой.
export const singleChoice: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['options'],
  supportsPlaceholder: false,
  // Список вариантов без вопроса — не вопрос, а мусор на полотне.
  requiresCaption: true,
  choice: 'single',
  issues: choiceIssues,
}
