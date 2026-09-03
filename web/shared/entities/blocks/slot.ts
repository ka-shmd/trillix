import { type BlockKindContract } from './contract'

// Запись на время (фаза 27, design/booking.md). Вопрос «когда вам удобно» с выбором
// свободного слота.
//
// СОБСТВЕННЫХ НАСТРОЕК В СХЕМЕ У НЕГО НЕТ: расписание, к которому он относится, живёт
// живой колонкой forms.schedule_id (ADR §10) — схема замерзает при публикации, и ссылка
// в ней потребовала бы перепубликации на смену расписания. Выбирает расписание автор в
// попапе блока; хранится выбор колонкой, и этой разницы он не видит.
//
// Плейсхолдера нет: подсказку внутри поля показывать негде — это не инпут, а список
// дат и времён. Блоков slot в форме не больше одного (ValidateSchema / validateSlot).
export const slot: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: true,
}
