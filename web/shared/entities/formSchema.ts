import { z } from 'zod'

// Схема формы — единый контракт двух сторон. Зеркало Go-типов и ValidateSchema
// из internal/domain/schema.go: любая правка формата (тип блока, лимит, поле)
// меняется здесь и там одним PR с тестами обеих сторон (web/CLAUDE.md).
//
// Общий источник для кабинета (web/app) и рендерера (web/renderer): оба
// импортируют его как `@entities/formSchema`. Дублировать типы руками запрещено —
// TS-типы выводятся через z.infer.

// Лимиты — те же числа, что в Go. Длины строк на фронте считаются в UTF-16
// code units (JS), в Go — в рунах; для ASCII-id и обычного текста расхождение
// несущественно, а серверная проверка в любом случае финальна.
export const SCHEMA_VERSION = 1
export const MAX_BLOCKS = 200
export const MAX_OPTIONS = 100
export const MAX_LABEL_LEN = 1000
export const MAX_DESCRIPTION_LEN = 2000
export const MAX_OPTION_LABEL_LEN = 500
export const MAX_ID_LEN = 64
export const MAX_SUBMIT_LABEL_LEN = 100
export const MAX_PLACEHOLDER_LEN = 200
// Ключ объекта картинки в бакете (uuid/<sha256>.ext ~ 105 симв.) и alt-текст.
export const MAX_IMAGE_KEY_LEN = 200
export const MAX_ALT_LEN = 500

// Текст кнопки отправки по умолчанию (когда submitLabel в схеме пуст).
export const DEFAULT_SUBMIT_LABEL = 'Отправить'

// Типы блоков: семь отвечаемых полей MVP (ARCHITECTURE 3.4) плюс два неотвечаемых
// (контентных): 'text' — статический абзац, 'image' — картинка на полотне. Оба не
// собирают ответ (исключены из ValidateAnswers/CSV/таблицы), рендерятся статикой.
export const blockTypeSchema = z.enum([
  'short_text',
  'long_text',
  'email',
  'number',
  'single_choice',
  'multi_choice',
  'date',
  'text',
  'image',
])
export type BlockType = z.infer<typeof blockTypeSchema>

const CHOICE_TYPES: ReadonlySet<BlockType> = new Set(['single_choice', 'multi_choice'])
export const isChoiceType = (t: BlockType): boolean => CHOICE_TYPES.has(t)

// Типы, у которых респондент вводит текст — для них можно задать плейсхолдер.
const PLACEHOLDER_TYPES: ReadonlySet<BlockType> = new Set([
  'short_text',
  'long_text',
  'email',
  'number',
])
export const supportsPlaceholder = (t: BlockType): boolean => PLACEHOLDER_TYPES.has(t)

// Неотвечаемые (контентные) блоки: 'text' и 'image'. Зеркалит Go isContent().
const CONTENT_TYPES: ReadonlySet<BlockType> = new Set(['text', 'image'])
export const isContentType = (t: BlockType): boolean => CONTENT_TYPES.has(t)
export const isAnswerableType = (t: BlockType): boolean => !isContentType(t)

// Стабильный id блока/опции: непустой, в пределах длины. Формат (blk_/opt_) не
// навязываем — id генерируется клиентом, важны непустота и уникальность.
const idSchema = z.string().min(1).max(MAX_ID_LEN)

// Вариант выбора у choice-блока.
export const optionSchema = z.strictObject({
  id: idSchema,
  label: z.string().max(MAX_OPTION_LABEL_LEN),
})
export type Option = z.infer<typeof optionSchema>

// Типоспецифичные настройки: пока только options у choice-типов. Пустой объект —
// валидное состояние non-choice блока. Лишние ключи запрещены (strictObject).
const settingsSchema = z.strictObject({
  options: z.array(optionSchema).max(MAX_OPTIONS).optional(),
  // Плейсхолдер поля ввода (текстовые типы). У остальных игнорируется.
  placeholder: z.string().max(MAX_PLACEHOLDER_LEN).optional(),
  // Картинка (тип image): ключ объекта в бакете и alt-текст. У остальных типов —
  // запрещены (superRefine ниже), как options у не-choice.
  imageKey: z.string().max(MAX_IMAGE_KEY_LEN).optional(),
  alt: z.string().max(MAX_ALT_LEN).optional(),
})

// Один вопрос формы. Пустой label и choice без опций допустимы — это нормальное
// недособранное состояние черновика, которое автосейв обязан хранить (зеркалит
// комментарий ValidateSchema в Go). Требование «непустой label, ≥1 опция» —
// правило момента публикации (фаза 4), не хранения.
export const blockSchema = z
  .strictObject({
    id: idSchema,
    type: blockTypeSchema,
    label: z.string().max(MAX_LABEL_LEN),
    description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
    required: z.boolean().optional(),
    settings: settingsSchema.optional(),
  })
  .superRefine((b, ctx) => {
    // imageKey/alt — только у image (как options только у choice).
    if (b.type !== 'image') {
      if (b.settings?.imageKey) {
        ctx.addIssue({
          code: 'custom',
          message: `тип ${b.type} не имеет картинки`,
          path: ['settings', 'imageKey'],
        })
      }
      if (b.settings?.alt) {
        ctx.addIssue({
          code: 'custom',
          message: `тип ${b.type} не имеет alt`,
          path: ['settings', 'alt'],
        })
      }
    }
    const options = b.settings?.options
    if (!isChoiceType(b.type)) {
      if (options && options.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `тип ${b.type} не имеет опций`,
          path: ['settings', 'options'],
        })
      }
      return
    }
    if (!options) return
    const seen = new Set<string>()
    options.forEach((o, i) => {
      if (seen.has(o.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `повторяющийся id опции ${o.id}`,
          path: ['settings', 'options', i, 'id'],
        })
      }
      seen.add(o.id)
    })
  })
export type Block = z.infer<typeof blockSchema>

// Документ черновика формы: версия формата и упорядоченный список блоков.
// Отсутствующая schemaVersion трактуется как текущая (дефолт БД '{"blocks":[]}').
export const formSchemaSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION).optional(),
    blocks: z.array(blockSchema).max(MAX_BLOCKS),
    // Текст кнопки отправки (форма-уровень). Пусто → рендерер берёт DEFAULT_SUBMIT_LABEL.
    submitLabel: z.string().max(MAX_SUBMIT_LABEL_LEN).optional(),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>()
    s.blocks.forEach((b, i) => {
      if (seen.has(b.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `повторяющийся id блока ${b.id}`,
          path: ['blocks', i, 'id'],
        })
      }
      seen.add(b.id)
    })
  })
export type FormSchema = z.infer<typeof formSchemaSchema>
