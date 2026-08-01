import { BLOCK_TYPES } from '@entities/blocks/contract'
import { type BlockType } from '@entities/formSchema'

import { consent } from './consent'
import { type EditorKind, type RowFacts } from './contract'
import { date } from './date'
import { dropdown } from './dropdown'
import { email } from './email'
import { formTitle } from './formTitle'
import { heading } from './heading'
import { image } from './image'
import { label } from './label'
import { longText } from './longText'
import { multiChoice } from './multiChoice'
import { numberField } from './number'
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
  title,
  label,
  heading,
  text,
  image,
  form_title: formTitle,
}

export const editorKind = (t: BlockType): EditorKind => EDITOR_KINDS[t]

// Факты о строке типа. Заголовок формы их не имеет (у него своя строка) — вызывающий
// обязан этот случай различать, поэтому null здесь не прячется за фолбэком.
export const rowFacts = (t: BlockType): RowFacts | null => EDITOR_KINDS[t].row

// Порядок обхода реестра — порядок BLOCK_TYPES из контракта, и от него зависит порядок
// пунктов в меню вставки (blockTypes.ts) и, через него, плоский индекс клавиатурной
// навигации инлайн-меню. Отдельного списка порядка нет намеренно: второй список
// разошёлся бы с первым молча.
export const orderedTypes: ReadonlyArray<BlockType> = BLOCK_TYPES

export { type EditorKind, type RowFacts, type RowSurface } from './contract'
