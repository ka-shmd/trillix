import { type BlockKindContract, type BlockType } from './contract'
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
import { multiSelect } from './multiSelect'
import { numberField } from './number'
import { pageBreak } from './pageBreak'
import { phone } from './phone'
import { rating } from './rating'
import { scale } from './scale'
import { shortText } from './shortText'
import { singleChoice } from './singleChoice'
import { slot } from './slot'
import { text } from './text'
import { title } from './title'

// Реестр типов блоков — контрактный слой (фаза 16, спека §3.2).
//
// Record<BlockType, …> БЕЗ Partial и без дефолтных значений — это не стилистика:
// дефолт превращает забытое поле в молчаливое поведение соседнего типа, ровно тот класс
// ошибки, от которого предупреждает чек-лист web/shared/fields/README.md («dropdown,
// не попавший в isSingleChoice(), уезжает в ветку multi_choice и начинает ждать массив
// вместо строки»). Новый тип без файла и без всех полей — ошибка компиляции.
export const BLOCK_KINDS: Record<BlockType, BlockKindContract> = {
  short_text: shortText,
  long_text: longText,
  email,
  phone,
  number: numberField,
  scale,
  rating,
  single_choice: singleChoice,
  dropdown,
  multi_choice: multiChoice,
  multi_select: multiSelect,
  date,
  file,
  slot,
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

export const blockKind = (t: BlockType): BlockKindContract => BLOCK_KINDS[t]

// Предикаты контракта — ВЫВОДЯТСЯ из реестра, а не перечисляют типы наборами.
//
// До фазы 16 их было семь независимых Set'ов, и добавление типа означало «не забыть про
// каждый». Забытый набор не падал: тип молча трактовался как соседний. Теперь
// рассинхронить нечего — источник один, а обязательность полей держит tsc.
//
// Имена и сигнатуры оставлены прежними: их читают десятки мест в обоих фронтах, и
// переименование ради красоты стоило бы диффа во всех, ничего не дав.

// Блоки-подписи группы (title/label): их text — подпись вопроса.
export const isCaptionType = (t: BlockType): boolean => blockKind(t).family === 'caption'

// Неотвечаемые блоки: подписи, оформление и заголовок формы. Не собирают ответ —
// исключены из ValidateAnswers, CSV, сводки и воронки.
export const isContentType = (t: BlockType): boolean => blockKind(t).family !== 'answer'

// Блок собирает ответ.
export const isAnswerableType = (t: BlockType): boolean => blockKind(t).family === 'answer'

// Тип несёт собственное поле text (подписи, контент, заголовок формы).
export const carriesText = (t: BlockType): boolean => blockKind(t).carriesText

// Настройки типа несут список опций. dropdown отличается от single_choice ТОЛЬКО
// контролом: та же модель опций, тот же формат ответа.
export const isChoiceType = (t: BlockType): boolean => blockKind(t).choice !== undefined

// Выбор ровно одного варианта (ответ — строка-id) против множественного (массив).
export const isSingleChoiceType = (t: BlockType): boolean => blockKind(t).choice === 'single'

// Множественный выбор (ответ — массив id). Выводится из двух предикатов выше, а не
// перечисляет типы: новый множественный choice-тип не придётся вспоминать в третьем
// месте. Зеркалит isMultiChoice в Go.
export const isMultiChoiceType = (t: BlockType): boolean => blockKind(t).choice === 'multi'

// Типы, у которых респондент вводит текст — для них можно задать плейсхолдер.
export const supportsPlaceholder = (t: BlockType): boolean => blockKind(t).supportsPlaceholder

// Правило ВСТАВКИ редактора: тип, который без подписи не задумывался, приезжает со своим
// заголовком. Зеркала в Go нет намеренно — блок без подписи остаётся валидным.
export const requiresCaption = (t: BlockType): boolean => blockKind(t).requiresCaption

// Типу разрешено делить ряд — всем, кроме заголовка формы.
export const canShareRow = (t: BlockType): boolean => blockKind(t).canShareRow
