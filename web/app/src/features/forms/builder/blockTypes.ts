import { type BlockType } from '@entities/formSchema'

import { editorKind, orderedTypes } from './kinds/index'

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

// Уточнение описания под раздел: один и тот же тип в «Вопросах» приезжает с заголовком, в
// «Отдельных полях» — голым, и автор обязан видеть разницу в самом пункте.
const GROUP_SUFFIX: Record<BlockGroup, string> = {
  question: ' С заголовком.',
  field: ' Без заголовка — подпись сгенерируется из плейсхолдера.',
  layout: '',
}

// Префикс ключа пункта: тип стоит в двух разделах, а key обязан быть уникальным. Записан
// явно, а не выведен из первой буквы раздела: ключи уезжают в e2e и в тесты навигации
// меню, и «q» из «question» — совпадение, на которое опираться не стоит.
const GROUP_KEY: Record<BlockGroup, string> = { question: 'q', field: 'f', layout: 'l' }

// MENU_ITEMS выводится из реестра типов (kinds/*): состав разделов объявляет сам тип
// (menu в его файле), подписи и описания — оттуда же. До фазы 16 здесь лежали два ручных
// списка (FIELD_TYPES и LAYOUT_TYPES), то есть третье место, где перечислены типы, — и
// тип, забытый в них, просто не появлялся в меню, ничего не ломая заметно.
//
// Порядок сохранён прежний — вопросы, поля, лэйаут, а внутри раздела порядок
// BLOCK_TYPES: на нём стоит плоский индекс клавиатурной навигации инлайн-меню.
export const MENU_ITEMS: ReadonlyArray<MenuItem> = BLOCK_GROUP_ORDER.flatMap((group) =>
  orderedTypes
    .filter((type) => editorKind(type).menu[group])
    .map((type): MenuItem => {
      const kind = editorKind(type)
      return {
        key: `${GROUP_KEY[group]}_${type}`,
        group,
        type,
        bundle: group === 'question',
        label: kind.label,
        description: `${kind.description}${GROUP_SUFFIX[group]}`,
      }
    }),
)

// filterMenuItems — пункты меню типов, отфильтрованные подстрокой по названию
// (единый фильтр для инлайн-слеша и «+»-диалога). Пустой запрос → весь список.
// Порядок MENU_ITEMS (вопросы → поля → лэйаут) сохраняется — на нём строится
// плоский индекс клавиатурной навигации инлайн-меню.
export function filterMenuItems(query: string): MenuItem[] {
  const q = query.trim().toLowerCase()
  return q ? MENU_ITEMS.filter((b) => b.label.toLowerCase().includes(q)) : [...MENU_ITEMS]
}
