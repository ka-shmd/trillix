import { type BlockKindContract } from './contract'

// Дата. Плейсхолдера нет: в поле даты браузер его не показывает, поэтому автору его и
// не предлагают (в редакторе строка даты — объектная остановка, а не инпут).
export const date: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
