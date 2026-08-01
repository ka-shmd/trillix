import { type BlockKindContract } from './contract'

// Заголовок ВОПРОСА — крупная подпись группы. Из её текста аналитика берёт имя колонки
// CSV и шага воронки (по groupId, не по позиции). С заголовком ФОРМЫ (form_title) не
// путать: тот рисуется вне потока вопросов.
export const title: BlockKindContract = {
  family: 'caption',
  carriesText: true,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
