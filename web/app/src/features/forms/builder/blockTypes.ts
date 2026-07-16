import { type BlockType } from '@entities/formSchema'

// Группа блока в диалоге добавления: «Вопросы» (отвечаемые поля) и «Лэйаут»
// (неотвечаемые блоки оформления — пока только текст).
export type BlockGroup = 'question' | 'layout'

export const BLOCK_GROUP_LABELS: Record<BlockGroup, string> = {
  question: 'Вопросы',
  layout: 'Лэйаут блоки',
}

// Порядок групп в диалоге.
export const BLOCK_GROUP_ORDER: BlockGroup[] = ['question', 'layout']

export interface BlockTypeMeta {
  type: BlockType
  label: string
  group: BlockGroup
  description: string
}

// Метаданные типов блоков: подпись, группа, описание. Единственное место
// соответствия type → подпись/описание; slash-меню и диалог берут отсюда.
export const BLOCK_TYPES: ReadonlyArray<BlockTypeMeta> = [
  {
    type: 'short_text',
    label: 'Короткий ответ',
    group: 'question',
    description: 'Однострочный ответ — имя, короткая фраза, ссылка.',
  },
  {
    type: 'long_text',
    label: 'Длинный ответ',
    group: 'question',
    description: 'Многострочный развёрнутый ответ.',
  },
  {
    type: 'email',
    label: 'Email',
    group: 'question',
    description: 'Адрес электронной почты с проверкой формата.',
  },
  {
    type: 'number',
    label: 'Число',
    group: 'question',
    description: 'Числовой ответ — количество, возраст, сумма.',
  },
  {
    type: 'single_choice',
    label: 'Один из списка',
    group: 'question',
    description: 'Выбор одного варианта из списка (радиокнопки).',
  },
  {
    type: 'multi_choice',
    label: 'Несколько из списка',
    group: 'question',
    description: 'Выбор нескольких вариантов из списка (флажки).',
  },
  {
    type: 'date',
    label: 'Дата',
    group: 'question',
    description: 'Выбор даты.',
  },
  {
    type: 'text',
    label: 'Текст',
    group: 'layout',
    description: 'Статический абзац текста — заголовок раздела или пояснение. Не запрашивает ответ.',
  },
  {
    type: 'image',
    label: 'Картинка',
    group: 'layout',
    description: 'Изображение на полотне формы (PNG или JPEG). Не запрашивает ответ.',
  },
]

export const blockTypeLabel = (t: BlockType): string =>
  BLOCK_TYPES.find((b) => b.type === t)?.label ?? t
