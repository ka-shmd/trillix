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
// Экран «после отправки»: текст благодарности владельца и ссылка перехода.
export const MAX_THANK_YOU_TEXT_LEN = 2000
export const MAX_REDIRECT_URL_LEN = 2000

// Текст кнопки отправки по умолчанию (когда submitLabel в схеме пуст).
export const DEFAULT_SUBMIT_LABEL = 'Отправить'

// Экран «Спасибо» по умолчанию (когда thankYouText в схеме пуст).
export const DEFAULT_THANK_YOU_TITLE = 'Спасибо!'
export const DEFAULT_THANK_YOU_TEXT = 'Ваш ответ отправлен.'

// isHttpUrl — единственное правило redirect-ссылки: абсолютный http(s)-URL с хостом.
// Зеркалит validateRedirectURL в Go. `javascript:`, `data:`, относительные пути
// отбрасываются: значение уходит в window.location, чужая схема там — это XSS на
// публичном домене формы (инвариант 4). Рендерер проверяет повторно перед переходом —
// доверять содержимому схемы на месте использования нельзя.
export const isHttpUrl = (raw: string): boolean => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
}

// Типы блоков: отвечаемые поля (ARCHITECTURE 3.4) плюс два неотвечаемых
// (контентных): 'text' — статический абзац, 'image' — картинка на полотне. Оба не
// собирают ответ (исключены из ValidateAnswers/CSV/таблицы), рендерятся статикой.
export const blockTypeSchema = z.enum([
  'short_text',
  'long_text',
  'email',
  'phone',
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
  'phone',
  'number',
])
export const supportsPlaceholder = (t: BlockType): boolean => PLACEHOLDER_TYPES.has(t)

// Телефон проверяется мягко (и здесь, и в Go): допустимые символы и количество
// цифр, а не формат конкретной страны. Жёсткая маска РФ отсекала бы легальные
// номера (+380, добавочные, международные) — для формы это дороже, чем принять
// нестандартную запись. Финальная инстанция — сервер (validPhone в answers.go).
export const MIN_PHONE_DIGITS = 5
export const MAX_PHONE_DIGITS = 20
const PHONE_ALLOWED = /^[0-9+()\-\s]+$/

export const isValidPhone = (raw: string): boolean => {
  if (!PHONE_ALLOWED.test(raw)) return false
  const digits = raw.replace(/\D/g, '').length
  return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS
}

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
    // Экран «после отправки» (форма-уровень, оба поля необязательны). Живут в схеме,
    // а не в колонках forms, осознанно: схема снапшотится при публикации, поэтому
    // респондент видит экран той версии, по которой отправил ответ.
    // Пусто → рендерер берёт DEFAULT_THANK_YOU_TITLE/TEXT.
    thankYouText: z.string().max(MAX_THANK_YOU_TEXT_LEN).optional(),
    // Ссылка перехода после отправки. Пусто → остаёмся на экране благодарности.
    redirectUrl: z.string().max(MAX_REDIRECT_URL_LEN).optional(),
  })
  .superRefine((s, ctx) => {
    // Схема redirect проверяется строго даже в черновике (в отличие от пустого label):
    // билдер коммитит поле в стор только по blur, поэтому недопечатанный URL до
    // автосейва не доезжает и 422 посреди набора не бывает.
    if (s.redirectUrl && !isHttpUrl(s.redirectUrl)) {
      ctx.addIssue({
        code: 'custom',
        message: 'ссылка должна начинаться с http:// или https://',
        path: ['redirectUrl'],
      })
    }

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
