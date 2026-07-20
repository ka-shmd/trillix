import { type BlockType } from '@entities/formSchema'

// Разделы меню добавления блока (v2, фаза 8.7):
//   • «Вопросы» — бандл: подпись (title) + поле. Выбор создаёт озаглавленный вопрос
//     (дефолт Tally: заголовок стоит).
//   • «Отдельные поля» — голое поле без заголовка (регистрация: несколько полей с
//     плейсхолдерами, подпись в аналитике генерится).
//   • «Лэйаут» — подписи и контент (title/label/heading/text/image) по отдельности.
export type BlockGroup = 'question' | 'field' | 'layout'

export const BLOCK_GROUP_LABELS: Record<BlockGroup, string> = {
  question: 'Вопросы',
  field: 'Отдельные поля',
  layout: 'Лэйаут',
}

export const BLOCK_GROUP_ORDER: BlockGroup[] = ['question', 'field', 'layout']

// MenuItem — пункт меню. bundle=true (раздел «Вопросы») создаёт title + поле; иначе
// один блок типа type. key уникален (тип может стоять и в «Вопросах», и в «Полях»).
export interface MenuItem {
  key: string
  group: BlockGroup
  type: BlockType
  bundle: boolean
  label: string
  description: string
}

// Отвечаемые типы — их подписи/описания (единый источник). Стоят и в «Вопросах»
// (бандлом), и в «Отдельных полях» (голыми).
const FIELD_TYPES: { type: BlockType; label: string; description: string }[] = [
  { type: 'short_text', label: 'Короткий ответ', description: 'Однострочный ответ — имя, короткая фраза, ссылка.' },
  { type: 'long_text', label: 'Длинный ответ', description: 'Многострочный развёрнутый ответ.' },
  { type: 'email', label: 'Email', description: 'Адрес электронной почты с проверкой формата.' },
  { type: 'phone', label: 'Телефон', description: 'Номер телефона. Проверяется мягко — любой формат записи.' },
  { type: 'number', label: 'Число', description: 'Числовой ответ — количество, возраст, сумма.' },
  { type: 'scale', label: 'Шкала', description: 'Оценка по шкале — от 1 до 5, NPS 0–10 и подобное.' },
  { type: 'single_choice', label: 'Один из списка', description: 'Выбор одного варианта из списка (радиокнопки).' },
  { type: 'dropdown', label: 'Выпадающий список', description: 'Выбор одного варианта из списка. Удобен, когда вариантов много.' },
  { type: 'multi_choice', label: 'Несколько из списка', description: 'Выбор нескольких вариантов из списка (флажки).' },
  { type: 'date', label: 'Дата', description: 'Выбор даты.' },
  { type: 'consent', label: 'Согласие', description: 'Галочка согласия со своим текстом — обработка данных, оферта, рассылка.' },
]

// Лэйаут-типы (подписи и контент) — по одному пункту.
const LAYOUT_TYPES: { type: BlockType; label: string; description: string }[] = [
  { type: 'title', label: 'Заголовок вопроса', description: 'Крупная подпись вопроса. Аналитика берёт из неё имя вопроса.' },
  { type: 'label', label: 'Подпись', description: 'Мелкая подпись поля — для компактных вопросов и полей регистрации.' },
  { type: 'heading', label: 'Заголовок раздела', description: 'Крупный заголовок секции формы. Не запрашивает ответ.' },
  { type: 'text', label: 'Текст', description: 'Статический абзац — пояснение или инструкция. Не запрашивает ответ.' },
  { type: 'image', label: 'Картинка', description: 'Изображение на полотне формы (PNG или JPEG). Не запрашивает ответ.' },
]

export const MENU_ITEMS: ReadonlyArray<MenuItem> = [
  ...FIELD_TYPES.map(
    (f): MenuItem => ({
      key: `q_${f.type}`,
      group: 'question',
      type: f.type,
      bundle: true,
      label: f.label,
      description: `${f.description} С заголовком.`,
    }),
  ),
  ...FIELD_TYPES.map(
    (f): MenuItem => ({
      key: `f_${f.type}`,
      group: 'field',
      type: f.type,
      bundle: false,
      label: f.label,
      description: `${f.description} Без заголовка — подпись сгенерируется из плейсхолдера.`,
    }),
  ),
  ...LAYOUT_TYPES.map(
    (l): MenuItem => ({
      key: `l_${l.type}`,
      group: 'layout',
      type: l.type,
      bundle: false,
      label: l.label,
      description: l.description,
    }),
  ),
]

// blockTypeLabel — человеческая подпись типа блока (единая с меню). Тип встречается
// в нескольких пунктах, но подпись у него одна.
const TYPE_LABELS = new Map<BlockType, string>(
  [...FIELD_TYPES, ...LAYOUT_TYPES].map((t) => [t.type, t.label]),
)
export const blockTypeLabel = (t: BlockType): string => TYPE_LABELS.get(t) ?? t
