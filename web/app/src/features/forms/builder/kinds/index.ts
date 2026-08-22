import { BLOCK_TYPES } from '@entities/blocks/contract'
import { type BlockType } from '@entities/formSchema'

import { consent } from './consent'
import { type EditorKind, type RowFacts } from './contract'
import { date } from './date'
import { dropdown } from './dropdown'
import { email } from './email'
import { file } from './file'
import { formTitle } from './formTitle'
import { heading } from './heading'
import { heading2 } from './heading2'
import { heading3 } from './heading3'
import { image } from './image'
import { label } from './label'
import { logic } from './logic'
import { longText } from './longText'
import { multiChoice } from './multiChoice'
import { numberField } from './number'
import { pageBreak } from './pageBreak'
import { phone } from './phone'
import { scale } from './scale'
import { shortText } from './shortText'
import { singleChoice } from './singleChoice'
import { text } from './text'
import { title } from './title'

// Реестр типов в редакторе (этап 16.1в) — третий слой среза по типам. Как и два
// предыдущих: исчерпывающий Record без Partial и без дефолтных значений, поэтому новый
// тип без файла или без поля не компилируется.
export const EDITOR_KINDS: Record<BlockType, EditorKind> = {
  short_text: shortText,
  long_text: longText,
  email,
  phone,
  number: numberField,
  scale,
  single_choice: singleChoice,
  dropdown,
  multi_choice: multiChoice,
  date,
  consent,
  file,
  title,
  label,
  heading,
  heading_2: heading2,
  heading_3: heading3,
  text,
  image,
  page_break: pageBreak,
  logic,
  form_title: formTitle,
}

export const editorKind = (t: BlockType): EditorKind => EDITOR_KINDS[t]

// Факты о строке типа. Заголовок формы их не имеет (у него своя строка) — вызывающий
// обязан этот случай различать, поэтому null здесь не прячется за фолбэком.
export const rowFacts = (t: BlockType): RowFacts | null => EDITOR_KINDS[t].row

// textIsBold — текст типа набирается жирным: пустая строка рождает первый символ с
// маркой `b` (жирность заголовков и подписей с 2026-08-15 лежит в документе, а не в весе
// поверхности — см. .rf-b в fields.css).
//
// Заголовок формы — ЕДИНСТВЕННЫЙ, кто отвечает здесь мимо реестра строк: своей строки у
// него нет вовсе (`row: null`, его рисует FormTitleRow), а жирным он набирается так же.
// Ветка живёт тут, а не у трёх вызывающих: иначе про заголовок формы однажды забудет один
// из них.
export const textIsBold = (t: BlockType): boolean => {
  const row = rowFacts(t)
  return row?.surface === 'text' ? row.bold : t === 'form_title'
}

// Порядок обхода реестра — порядок BLOCK_TYPES из контракта, и от него зависит порядок
// пунктов в меню вставки (blockTypes.ts) и, через него, плоский индекс клавиатурной
// навигации инлайн-меню. Отдельного списка порядка нет намеренно: второй список
// разошёлся бы с первым молча.
export const orderedTypes: ReadonlyArray<BlockType> = BLOCK_TYPES

export { type EditorKind, type RowFacts, type RowSurface } from './contract'
