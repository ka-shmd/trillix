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
export const SCHEMA_VERSION = 3
export const MAX_BLOCKS = 200
export const MAX_OPTIONS = 100
// Суммарная длина текста блока по всем спанам (title/label/heading/text/consent).
// Зеркалит MaxTextLen в Go. Число то же, что было у строки в v2: текст не стал длиннее
// от того, что его покрасили.
export const MAX_TEXT_LEN = 2000
// Число спанов в тексте одного блока. Зеркалит MaxSpans. Второй лимит обязателен: без
// него MAX_TEXT_LEN перестал быть лимитом документа в тот момент, когда строка стала
// массивом (2000 кусков по одному символу прошли бы проверку длины).
export const MAX_SPANS = 200
export const MAX_OPTION_LABEL_LEN = 500
export const MAX_ID_LEN = 64
export const MAX_SUBMIT_LABEL_LEN = 100
export const MAX_PLACEHOLDER_LEN = 200
// Ключ объекта картинки в бакете (uuid/<sha256>.ext ~ 105 симв.).
export const MAX_IMAGE_KEY_LEN = 200
// Экран «после отправки»: текст благодарности владельца и ссылка перехода.
export const MAX_THANK_YOU_TEXT_LEN = 2000
export const MAX_REDIRECT_URL_LEN = 2000
// Границы диапазона шкалы. Верх — 10: шкала это ряд кнопок, а не поле ввода, и на
// телефоне больше десяти в строку не помещается (нужно число — есть тип number).
// Низ — 0: NPS считается от нуля. Диапазон новой шкалы — 1–5.
export const SCALE_LOWER_BOUND = 0
export const SCALE_UPPER_BOUND = 10
export const DEFAULT_SCALE_MIN = 1
export const DEFAULT_SCALE_MAX = 5

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

// Типы блоков (ARCHITECTURE 3.4, модель v2). Три семьи: отвечаемые поля (собирают
// ответ), подписи ('title'/'label' — текст вопроса в группе) и контент
// ('heading'/'text'/'image' — оформление). Подписи и контент неотвечаемы
// (исключены из ValidateAnswers/CSV/таблицы). 'consent' — отвечаемый, но несёт
// собственный текст согласия рядом с галочкой.
export const blockTypeSchema = z.enum([
  // отвечаемые
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
  'scale',
  'single_choice',
  'dropdown',
  'multi_choice',
  'date',
  'consent',
  // подписи
  'title',
  'label',
  // контент
  'heading',
  'text',
  'image',
])
export type BlockType = z.infer<typeof blockTypeSchema>

// Типы, чьи настройки несут список опций. dropdown отличается от single_choice
// ТОЛЬКО контролом (список против радиокнопок): та же модель опций, тот же формат
// ответа — id варианта строкой.
const CHOICE_TYPES: ReadonlySet<BlockType> = new Set(['single_choice', 'dropdown', 'multi_choice'])
export const isChoiceType = (t: BlockType): boolean => CHOICE_TYPES.has(t)

// Выбор ровно одного варианта (ответ — строка-id) против множественного (массив).
// Отдельный предикат, а не сравнение с single_choice: забытый здесь dropdown
// молча уехал бы в ветку multi и ждал массив.
const SINGLE_CHOICE_TYPES: ReadonlySet<BlockType> = new Set(['single_choice', 'dropdown'])
export const isSingleChoiceType = (t: BlockType): boolean => SINGLE_CHOICE_TYPES.has(t)

// Типы, у которых респондент вводит текст — для них можно задать плейсхолдер.
const PLACEHOLDER_TYPES: ReadonlySet<BlockType> = new Set([
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
])
export const supportsPlaceholder = (t: BlockType): boolean => PLACEHOLDER_TYPES.has(t)

// Типы, поле которых не существует без подписи (решение владельца 2026-07-26):
// список вариантов или шкала без вопроса — не вопрос, а мусор на полотне. Отсюда
// же следует, что строкой такого поля нельзя управлять отдельно (кластер значков
// живёт на подписи): разлучать нечего, они всегда вместе.
//
// Это правило РЕДАКТОРА, а не схемы: зеркала в Go нет, и валидации нет ни здесь, ни
// там — блок без подписи остаётся валидным. Причина та же, что у бита ряда (§13
// EDITOR.md): кросс-блочное условие в валидаторе ловило бы 422 на undo и на
// промежуточных состояниях драга. Держит правило стор билдера — вставка такого типа
// либо входит в группу ждущей подписи, либо приезжает со своим заголовком.
const CAPTION_REQUIRED_TYPES: ReadonlySet<BlockType> = new Set([
  'single_choice',
  'dropdown',
  'multi_choice',
  'scale',
])
export const requiresCaption = (t: BlockType): boolean => CAPTION_REQUIRED_TYPES.has(t)

// Типы, которым разрешено делить ряд с предыдущим вопросом (спека §5, ADR §10):
// визуально короткие контролы. long_text/scale/choice-карточки в половину колонки
// не читаются. Зеркалит Go canShareRow().
const SHARE_ROW_TYPES: ReadonlySet<BlockType> = new Set([
  'short_text',
  'email',
  'phone',
  'number',
  'date',
  'dropdown',
])
export const canShareRow = (t: BlockType): boolean => SHARE_ROW_TYPES.has(t)

// Единственное значение бита ряда (спека §5): «встань в ряд с предыдущим».
// Отсутствие ключа = свой ряд; 'left' канон не пишет и не принимает. Зеркалит
// Go ColumnRight.
export const COLUMN_RIGHT = 'right'

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

// Значение отмеченного согласия. Ответ хранится строкой, а не булевым: это
// конвенция проекта (number и date тоже строки), и главное — пустая строка = «не
// отмечено» бесплатно ложится на isEmpty в validation.ts, поэтому обязательность
// работает без спецслучая. Булев false туда не попадал бы (false !== ''), и
// required у согласия молча перестал бы работать.
export const CONSENT_YES = 'yes'

// Блоки-подписи группы ('title'/'label'): их text — подпись вопроса. title
// крупная, label мелкая — только вид. Зеркалит Go isCaption().
const CAPTION_TYPES: ReadonlySet<BlockType> = new Set(['title', 'label'])
export const isCaptionType = (t: BlockType): boolean => CAPTION_TYPES.has(t)

// Неотвечаемые (контентные) блоки: подписи ('title'/'label') и оформление
// ('heading'/'text'/'image'). Зеркалит Go isContent().
const CONTENT_TYPES: ReadonlySet<BlockType> = new Set(['title', 'label', 'heading', 'text', 'image'])
export const isContentType = (t: BlockType): boolean => CONTENT_TYPES.has(t)
export const isAnswerableType = (t: BlockType): boolean => !isContentType(t)

// Типы с собственным полем text: подписи, контентные абзацы/заголовки и consent
// (текст согласия рядом с галочкой). У прочих отвечаемых и у image поле text
// обязано быть пустым. Зеркалит Go carriesText().
const CARRIES_TEXT_TYPES: ReadonlySet<BlockType> = new Set([
  'title',
  'label',
  'heading',
  'text',
  'consent',
])
export const carriesText = (t: BlockType): boolean => CARRIES_TEXT_TYPES.has(t)

// Богатый текст блока (v3): плоский массив спанов вместо строки. Формат — ADR §10
// ARCHITECTURE, обоснование и инварианты — docs/DESIGN-rich-text.md §2. Зеркало —
// internal/domain/spans.go (правится тем же PR, с тестами обеих сторон).
//
// Булевы марки списком, значимые — своими полями. Список булевых открыт по
// построению: новая марка — строка в MARKS, строка в fields.css, кнопка в панель.
export const MARKS = ['b', 'i', 'u', 's'] as const
export const markSchema = z.enum(MARKS)
export type Mark = z.infer<typeof markSchema>

// Цвет — строгий `#rrggbb` в нижнем регистре, а не произвольная CSS-нотация (ADR §10,
// решение владельца 2026-07-26 «цвет свободный»): значение уходит в inline-style
// рендерера, и хотя React его экранирует, свободная нотация открыла бы место под
// url(...) и наследие expression. Зеркалит isHexColor в Go.
const HEX_COLOR = /^#[0-9a-f]{6}$/
export const isHexColor = (s: string): boolean => HEX_COLOR.test(s)

// Спан — кусок текста с одинаковым оформлением. t непуст: пустой кусок — мусор,
// который пришлось бы тащить через три поверхности рендера и через plainText.
export const spanSchema = z.strictObject({
  t: z.string().min(1).max(MAX_TEXT_LEN),
  m: z.array(markSchema).optional(),
  color: z.string().regex(HEX_COLOR).optional(),
  bg: z.string().regex(HEX_COLOR).optional(),
  // Ссылка — единственная марка с угрозой безопасности. Валидатор переиспользуется,
  // а не пишется заново (ADR §10): тот же isHttpUrl, что у redirectUrl.
  href: z.string().max(MAX_REDIRECT_URL_LEN).refine(isHttpUrl, 'нужен http(s)-адрес').optional(),
})
export type Span = z.infer<typeof spanSchema>

// richTextSchema — текст блока целиком. Два лимита: число кусков (здесь) и суммарная
// длина (superRefine ниже) — по отдельности ни один не ограничивает документ.
//
// Склейка соседних одинаково размеченных кусков НЕ проверяется: это обязанность
// редактора. Кросс-элементное условие в валидаторе ловило бы 422 на undo и на
// промежуточных состояниях набора, а автосейв обязан хранить недособранное — то же
// решение, что у инертного бита ряда.
export const richTextSchema = z
  .array(spanSchema)
  .max(MAX_SPANS)
  .superRefine((spans, ctx) => {
    const total = spans.reduce((n, s) => n + s.t.length, 0)
    if (total > MAX_TEXT_LEN) {
      ctx.addIssue({ code: 'custom', message: `текст длиннее ${MAX_TEXT_LEN} символов` })
    }
    for (const [i, s] of spans.entries()) {
      const dup = s.m && new Set(s.m).size !== s.m.length
      if (dup) {
        ctx.addIssue({ code: 'custom', message: 'повторяющаяся марка', path: [i, 'm'] })
      }
    }
  })

// plainText — текст без оформления. Единственный способ, которым богатый текст попадает
// в данные: подписи для CSV/воронки/сводки, тизер ссылки, aria-label. Зеркалит
// PlainText в Go. Разметка в данные не протекает никогда.
export const plainText = (spans: Span[] | undefined): string =>
  spans ? spans.map((s) => s.t).join('') : ''

// sameRichText — равенство богатого текста ПО ЗНАЧЕНИЮ. Нужно там, где раньше хватало
// сравнения строк по ссылке: набор символа приносит свежий массив с тем же содержимым,
// и по ссылке любая правка выглядела бы изменением. От этого зависят три вещи, каждая
// из которых ломается молча: no-op в updateBlock (лишний шаг истории — Ctrl+Z «съедает»
// нажатие), флаг dirty и лишний PATCH автосейва.
export const sameRichText = (a: Span[] | undefined, b: Span[] | undefined): boolean => {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  return x.every((s, i) => {
    const o = y[i]!
    if (s.t !== o.t || s.color !== o.color || s.bg !== o.bg || s.href !== o.href) return false
    const sm = s.m ?? []
    const om = o.m ?? []
    return sm.length === om.length && sm.every((m, j) => m === om[j])
  })
}

// textFromString — подъём плоской строки в спаны (редактор, тесты). Пустая строка даёт
// пустой массив, а не массив с пустым куском: одно представление пустоты, иначе дифф
// автосейва шумит на ровном месте. Зеркалит TextFromString в Go.
export const textFromString = (s: string): Span[] => (s === '' ? [] : [{ t: s }])

// Стабильный id блока/опции: непустой, в пределах длины. Формат (blk_/opt_) не
// навязываем — id генерируется клиентом, важны непустота и уникальность.
const idSchema = z.string().min(1).max(MAX_ID_LEN)

// Вариант выбора у choice-блока.
export const optionSchema = z.strictObject({
  id: idSchema,
  label: z.string().max(MAX_OPTION_LABEL_LEN),
  // Тот же бит ряда, что у блока (спека §5.1): 'right' = «встань в ряд с
  // предыдущим вариантом», отсутствие = свой ряд. Свободна ли ячейка слева — не
  // валидируется, как и у блока: флаг инертен, а не невалиден. У опций dropdown
  // инертен всегда (список живёт в нативном select) — и потому не запрещён.
  column: z.literal(COLUMN_RIGHT).optional(),
})
export type Option = z.infer<typeof optionSchema>

// Типоспецифичные настройки: пока только options у choice-типов. Пустой объект —
// валидное состояние non-choice блока. Лишние ключи запрещены (strictObject).
const settingsSchema = z.strictObject({
  options: z.array(optionSchema).max(MAX_OPTIONS).optional(),
  // Плейсхолдер поля ввода (текстовые типы). У остальных игнорируется.
  placeholder: z.string().max(MAX_PLACEHOLDER_LEN).optional(),
  // Картинка (тип image): ключ объекта в бакете. У остальных типов запрещён
  // (superRefine ниже), как options у не-choice.
  imageKey: z.string().max(MAX_IMAGE_KEY_LEN).optional(),
  // Диапазон шкалы (тип scale). Оба конца или ни одного (superRefine ниже);
  // «ни одного» — недособранный черновик, как choice без опций.
  scaleMin: z.number().int().optional(),
  scaleMax: z.number().int().optional(),
  // Ряд из двух вопросов (спека §5): 'right' на отвечаемом блоке = «встань в ряд
  // с предыдущим вопросом», отсутствие ключа = свой ряд. Ширина не хранится вовсе,
  // её выводит раскладчик. Разрешён только whitelist-типам (superRefine ниже);
  // кросс-блочное условие «слева есть свободная ячейка» намеренно не валидируется
  // — инертный флаг легален, иначе undo и промежуточные состояния драга ловили бы 422.
  column: z.literal(COLUMN_RIGHT).optional(),
})

// scaleRange — диапазон шкалы блока с фолбэком на дефолт, если схема его не несёт.
// Зеркалит scaleRange в Go. Общий для контрола поля и валидации.
export const scaleRange = (block: Block): { min: number; max: number } => {
  const { scaleMin, scaleMax } = block.settings ?? {}
  return scaleMin !== undefined && scaleMax !== undefined
    ? { min: scaleMin, max: scaleMax }
    : { min: DEFAULT_SCALE_MIN, max: DEFAULT_SCALE_MAX }
}

// Один блок формы (v2). groupId связывает блоки одного вопроса. Пустой text и
// choice без опций допустимы — нормальное недособранное состояние черновика,
// которое автосейв обязан хранить (зеркалит комментарий ValidateSchema в Go).
// Требование «непустая подпись, ≥1 опция» — правило момента публикации, не хранения.
export const blockSchema = z
  .strictObject({
    id: idSchema,
    groupId: idSchema,
    type: blockTypeSchema,
    text: richTextSchema.optional(),
    required: z.boolean().optional(),
    settings: settingsSchema.optional(),
  })
  .superRefine((b, ctx) => {
    // Собственный text — только у carriesText-типов (подписи, контент, consent).
    if (b.text?.length && !carriesText(b.type)) {
      ctx.addIssue({
        code: 'custom',
        message: `тип ${b.type} не несёт собственного текста`,
        path: ['text'],
      })
    }
    // imageKey — только у image (как options только у choice).
    if (b.type !== 'image' && b.settings?.imageKey) {
      ctx.addIssue({
        code: 'custom',
        message: `тип ${b.type} не имеет картинки`,
        path: ['settings', 'imageKey'],
      })
    }
    // column: 'right' — только у whitelist-типов (спека §5).
    if (b.settings?.column && !canShareRow(b.type)) {
      ctx.addIssue({
        code: 'custom',
        message: `тип ${b.type} не может делить ряд`,
        path: ['settings', 'column'],
      })
    }
    // Диапазон шкалы — только у scale (как options у choice).
    const { scaleMin, scaleMax } = b.settings ?? {}
    if (b.type !== 'scale') {
      if (scaleMin !== undefined || scaleMax !== undefined) {
        ctx.addIssue({ code: 'custom', message: `тип ${b.type} не имеет шкалы`, path: ['settings', 'scaleMin'] })
      }
    } else if (scaleMin !== undefined || scaleMax !== undefined) {
      if (scaleMin === undefined || scaleMax === undefined) {
        ctx.addIssue({ code: 'custom', message: 'шкала: нужны оба конца диапазона', path: ['settings'] })
      } else if (scaleMin < SCALE_LOWER_BOUND || scaleMax > SCALE_UPPER_BOUND) {
        ctx.addIssue({
          code: 'custom',
          message: `шкала: диапазон вне [${SCALE_LOWER_BOUND}, ${SCALE_UPPER_BOUND}]`,
          path: ['settings'],
        })
      } else if (scaleMin >= scaleMax) {
        ctx.addIssue({ code: 'custom', message: 'шкала: минимум не меньше максимума', path: ['settings'] })
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
    // Опционально: пустой дефолт БД без версии трактуется как текущая; сервер при
    // сохранении канонизирует. Стор билдера всегда шлёт SCHEMA_VERSION явно.
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
    // Группы (v2, зеркалит Go validateGroups): блоки одной группы идут подряд, в
    // группе не более одного отвечаемого блока. Связь подписи с полем — по groupId,
    // не по позиции.
    const answerablePerGroup = new Map<string, number>()
    const endedRun = new Set<string>()
    let prevGroup = ''
    s.blocks.forEach((b, i) => {
      if (seen.has(b.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `повторяющийся id блока ${b.id}`,
          path: ['blocks', i, 'id'],
        })
      }
      seen.add(b.id)

      if (b.groupId !== prevGroup) {
        if (endedRun.has(b.groupId)) {
          ctx.addIssue({
            code: 'custom',
            message: `группа ${b.groupId} не смежна (блоки группы разорваны)`,
            path: ['blocks', i, 'groupId'],
          })
        }
        if (prevGroup !== '') endedRun.add(prevGroup)
        prevGroup = b.groupId
      }
      if (isAnswerableType(b.type)) {
        const n = (answerablePerGroup.get(b.groupId) ?? 0) + 1
        answerablePerGroup.set(b.groupId, n)
        if (n > 1) {
          ctx.addIssue({
            code: 'custom',
            message: `в группе ${b.groupId} больше одного отвечаемого блока`,
            path: ['blocks', i, 'type'],
          })
        }
      }
    })
  })
export type FormSchema = z.infer<typeof formSchemaSchema>
