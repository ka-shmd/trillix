import { type BlockKindContract } from './contract'

// Согласие — галочка со своим текстом (обработка данных, оферта, рассылка). Единственный
// ОТВЕЧАЕМЫЙ тип, который несёт собственный text: этот текст и есть строка вопроса,
// поэтому подпись группы ему не нужна, а аналитика берёт имя из него самого.
// Ответ — строка CONSENT_YES или пусто (не булев false: пустая строка бесплатно ложится
// на isEmpty, и обязательность работает без спецслучая).
export const consent: BlockKindContract = {
  family: 'answer',
  carriesText: true,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
