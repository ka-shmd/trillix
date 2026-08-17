import {
  type Block,
  type BlockType,
  type FormSchema,
  SCHEMA_VERSION,
  textFromString,
} from '@entities/formSchema'

// Встроенные шаблоны форм: с чего начать вместо пустого полотна. Живут статикой на
// фронте — ни таблицы, ни ручки у них нет, потому что нет и второго источника: свои и
// публичные шаблоны это отдельная работа (POST-MVP, фаза 19), и до неё галерее нечего
// хранить на сервере.
//
// Шаблон описывается вопросами, а не блоками: раскладку по группам («подпись + поле» —
// один вопрос, EDITOR.md §1) делает buildTemplateSchema. Иначе каждый шаблон был бы
// россыпью блоков с руками проставленными groupId, и первая же опечатка дала бы форму,
// у которой вопрос называется чужой подписью.

// Тип поля, которым отвечают на вопрос шаблона. Список узкий намеренно: шаблон —
// заготовка, а не витрина возможностей редактора.
type AnswerType = Extract<
  BlockType,
  'short_text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'scale' | 'single_choice' | 'multi_choice' | 'dropdown'
>

export type TemplateItem =
  // Вопрос: подпись + поле ответа. `q` уезжает в подпись, она же имя колонки выгрузки.
  | {
      q: string
      type: AnswerType
      required?: boolean
      placeholder?: string
      options?: string[]
      // Оба конца шкалы или ни одного — правило типа scale (blocks/scale.ts).
      scale?: [number, number]
    }
  // Абзац-пояснение: контент, ответа не собирает.
  | { note: string }
  // Согласие: своё поле ответа с собственным текстом, подписи ему не нужно.
  | { consent: string; required?: boolean }

export interface FormTemplate {
  id: string
  // Заголовок будущей формы: уезжает и в блок form_title, и (зеркалом на сервере) в
  // колонку forms.title.
  title: string
  // Чем шаблон полезен — строка под названием в карточке галереи.
  description: string
  items: TemplateItem[]
}

const newId = (): string => `blk_${crypto.randomUUID()}`
const newOptionId = (): string => `opt_${crypto.randomUUID()}`

// buildTemplateSchema — шаблон в документ формы. Id генерируются на КАЖДЫЙ вызов: две
// формы из одного шаблона не должны делить `blk_*`, иначе ответы, воронка и логика двух
// разных форм ссылались бы на одни и те же строки.
export function buildTemplateSchema(template: FormTemplate): FormSchema {
  const blocks: Block[] = [
    { id: newId(), groupId: newId(), type: 'form_title', text: textFromString(template.title) },
  ]

  for (const item of template.items) {
    const groupId = newId()
    if ('note' in item) {
      blocks.push({ id: newId(), groupId, type: 'text', text: textFromString(item.note) })
      continue
    }
    if ('consent' in item) {
      blocks.push({
        id: newId(),
        groupId,
        type: 'consent',
        text: textFromString(item.consent),
        ...(item.required ? { required: true } : {}),
      })
      continue
    }
    blocks.push({ id: newId(), groupId, type: 'title', text: textFromString(item.q) })
    blocks.push({
      id: newId(),
      groupId,
      type: item.type,
      ...(item.required ? { required: true } : {}),
      settings: {
        ...(item.placeholder ? { placeholder: item.placeholder } : {}),
        ...(item.options
          ? { options: item.options.map((label) => ({ id: newOptionId(), label })) }
          : {}),
        ...(item.scale ? { scaleMin: item.scale[0], scaleMax: item.scale[1] } : {}),
      },
    })
  }

  return { schemaVersion: SCHEMA_VERSION, blocks }
}

// questionCaptions — о чём шаблон спрашивает; карточка галереи печатает первые из них.
export function questionCaptions(template: FormTemplate): string[] {
  return template.items.map((i) => ('q' in i ? i.q : 'consent' in i ? i.consent : null)).filter(
    (s): s is string => s !== null,
  )
}

export const TEMPLATES: FormTemplate[] = [
  {
    id: 'feedback',
    title: 'Обратная связь',
    description: 'Оценка работы и два вопроса по существу — форма, которую заполняют за минуту.',
    items: [
      { note: 'Нам важно ваше мнение: ответы читает вся команда.' },
      { q: 'Как вы оцениваете нашу работу?', type: 'scale', scale: [1, 5], required: true },
      { q: 'Что понравилось больше всего?', type: 'long_text' },
      { q: 'Что стоит улучшить?', type: 'long_text' },
      { q: 'Email, если ждёте ответа', type: 'email', placeholder: 'you@example.com' },
    ],
  },
  {
    id: 'consultation',
    title: 'Запись на консультацию',
    description: 'Контакты, удобные дата и время, тема разговора — всё, чтобы перезвонить по делу.',
    items: [
      { q: 'Как вас зовут?', type: 'short_text', required: true },
      { q: 'Телефон', type: 'phone', required: true },
      { q: 'Email', type: 'email' },
      { q: 'Удобная дата', type: 'date', required: true },
      {
        q: 'Удобное время',
        type: 'single_choice',
        options: ['Утро, 9:00–12:00', 'День, 12:00–17:00', 'Вечер, 17:00–20:00'],
      },
      { q: 'О чём хотите поговорить?', type: 'long_text' },
      { consent: 'Согласен на обработку персональных данных', required: true },
    ],
  },
  {
    id: 'event',
    title: 'Регистрация на событие',
    description: 'Список участников с форматом участия и интересными им темами.',
    items: [
      { note: 'Заполните форму — за день до встречи пришлём напоминание и ссылку.' },
      { q: 'Имя и фамилия', type: 'short_text', required: true },
      { q: 'Email', type: 'email', required: true, placeholder: 'you@example.com' },
      {
        q: 'Как будете участвовать?',
        type: 'single_choice',
        options: ['Приду лично', 'Подключусь онлайн'],
        required: true,
      },
      {
        q: 'Какие темы вам интересны?',
        type: 'multi_choice',
        options: ['Практика и разборы', 'Инструменты', 'Ответы на вопросы', 'Общение с коллегами'],
      },
      { q: 'Вопрос спикеру', type: 'long_text' },
      { consent: 'Согласен на обработку персональных данных', required: true },
    ],
  },
  {
    id: 'candidate',
    title: 'Анкета кандидата',
    description: 'Отклики на вакансию в одной таблице: контакты, опыт, ссылка на резюме.',
    items: [
      { q: 'Имя и фамилия', type: 'short_text', required: true },
      { q: 'Email', type: 'email', required: true, placeholder: 'you@example.com' },
      { q: 'Телефон', type: 'phone' },
      { q: 'Ссылка на резюме или профиль', type: 'short_text', placeholder: 'https://' },
      { q: 'Сколько лет опыта в профессии?', type: 'number' },
      { q: 'Почему вам интересна эта вакансия?', type: 'long_text', required: true },
      { consent: 'Согласен на обработку персональных данных', required: true },
    ],
  },
  {
    id: 'order',
    title: 'Заявка на услугу',
    description: 'Что нужно клиенту, к какому сроку и как с ним связаться.',
    items: [
      { q: 'Как к вам обращаться?', type: 'short_text', required: true },
      { q: 'Телефон', type: 'phone', required: true },
      {
        q: 'Какая услуга нужна?',
        type: 'dropdown',
        options: ['Консультация', 'Разовая работа', 'Долгосрочное сотрудничество', 'Пока не знаю'],
        required: true,
      },
      { q: 'Опишите задачу', type: 'long_text', required: true },
      { q: 'Когда нужен результат?', type: 'date' },
      { consent: 'Согласен на обработку персональных данных', required: true },
    ],
  },
  {
    id: 'nps',
    title: 'Оценка мероприятия',
    description: 'Одна шкала от 0 до 10 и вопрос «почему» — замер, который считают каждый раз одинаково.',
    items: [
      {
        q: 'Насколько вы готовы порекомендовать нас коллегам?',
        type: 'scale',
        scale: [0, 10],
        required: true,
      },
      { q: 'Что повлияло на вашу оценку?', type: 'long_text' },
      { q: 'Email, если хотите продолжить разговор', type: 'email' },
    ],
  },
]
