import { type BlockKindContract } from './contract'

// Короткий ответ — однострочный текст (имя, фраза, ссылка). Базовый отвечаемый тип:
// собственного текста не несёт (строка вопроса — подпись его группы), закреплённых
// настроек у него нет, плейсхолдер поддерживает.
export const shortText: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: true,
  requiresCaption: false,
}
