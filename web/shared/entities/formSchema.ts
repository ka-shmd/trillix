import { z } from 'zod'
import { BLOCK_TYPES } from './blocks/contract'
// Импортируется только то, чем пользуется САМ этот файл; предикаты, которые он лишь
// отдаёт наружу, идут реэкспортом ниже (иначе линтер справедливо считает их неиспользованными).
import { blockKind, canShareRow, carriesText, isAnswerableType } from './blocks/index'
import {
  MAX_BLOCKS,
  MAX_FORM_TITLE_LEN,
  MAX_QUESTION_NAME_LEN,
  MAX_REDIRECT_URL_LEN,
  MAX_SPANS,
  MAX_SUBMIT_LABEL_LEN,
  MAX_TEXT_LEN,
  MAX_THANK_YOU_TEXT_LEN,
} from './blocks/limits'
import { OWNED_SETTINGS, idSchema, settingsSchema } from './blocks/settings'

// Схема формы — единый контракт двух сторон. Зеркало Go-типов и ValidateSchema
// из internal/domain/schema.go: любая правка формата (тип блока, лимит, поле)
// меняется здесь и там одним PR с тестами обеих сторон (web/CLAUDE.md).
//
// Общий источник для кабинета (web/app) и рендерера (web/renderer): оба
// импортируют его как `@entities/formSchema`. Дублировать типы руками запрещено —
// TS-типы выводятся через z.infer.
//
// Фаза 16 разнесла СВОЙСТВА типов по файлам (`blocks/<type>.ts`, реестр —
// `blocks/index.ts`), а этот файл оставила тем, чем он и был: правилами ДОКУМЕНТА
// (уникальность id, смежность групп, потолок блоков, инварианты заголовка формы) плюс
// точкой входа контракта. Всё, что раньше отсюда импортировали приложения, отсюда же
// и импортируется — реэкспорты ниже; переезд файлов ни одного потребителя не тронул.

// Текущая версия формата. v4 (фаза 15) добавила блок заголовка формы; апгрейд
// старых документов живёт только на бэке (domain.ValidateSchema, цепочка
// v1→v2→v3→v4), фронту всегда приезжает канон текущей версии.
export const SCHEMA_VERSION = 4

// Лимиты, схема настроек и предикаты типов — из реестра (blocks/). Реэкспорт, а не
// повторное объявление: два объявления одного лимита — это два лимита.
export * from './blocks/limits'
export { type BlockType } from './blocks/contract'
export {
  BLOCK_KINDS,
  blockKind,
  canShareRow,
  carriesText,
  isAnswerableType,
  isCaptionType,
  isChoiceType,
  isContentType,
  isSingleChoiceType,
  requiresCaption,
  supportsPlaceholder,
} from './blocks/index'
export {
  COLUMN_LEFT,
  COLUMN_RIGHT,
  columnSchema,
  optionSchema,
  settingsSchema,
  type Option,
  type Settings,
} from './blocks/settings'
export { scaleRange } from './blocks/scale'

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

// Тип блока. Список значений — из реестра (blocks/contract.ts, BLOCK_TYPES): значение
// enum и файл типа появляются вместе, поэтому «тип есть в схеме, но про него ничего не
// известно» невозможно по построению.
//
// Три семьи: отвечаемые поля (собирают ответ), подписи ('title'/'label' — текст вопроса
// в группе) и контент ('heading'/'text'/'image' — оформление). Подписи и контент
// неотвечаемы (исключены из ValidateAnswers/CSV/таблицы). 'consent' — отвечаемый, но
// несёт собственный текст согласия рядом с галочкой. Семью объявляет файл типа, а
// предикаты (isCaptionType/isContentType/carriesText/isChoiceType/…) ВЫВОДЯТСЯ из
// реестра: до фазы 16 это были семь независимых наборов, и тип, забытый в наборе, молча
// трактовался как соседний.
export const blockTypeSchema = z.enum(BLOCK_TYPES)






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




// Богатый текст блока (v3): плоский массив спанов вместо строки. Формат — ADR §10
// ARCHITECTURE, обоснование и инварианты — docs/design/rich-text.md §2. Зеркало —
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




// Один блок формы (v2). groupId связывает блоки одного вопроса. Пустой text и
// choice без опций допустимы — нормальное недособранное состояние черновика,
// которое автосейв обязан хранить (зеркалит комментарий ValidateSchema в Go).
// Правила момента публикации нет вовсе: гейт, введённый фазой 16, снят решением
// владельца (ADR §10) — форма публикуется в любом состоянии.
export const blockSchema = z
  .strictObject({
    id: idSchema,
    groupId: idSchema,
    type: blockTypeSchema,
    text: richTextSchema.optional(),
    // Имя вопроса (фаза 16, ADR §10) — необязательное ПЕРЕОПРЕДЕЛЕНИЕ строки, которой
    // вопрос называется в данных (колонка CSV, шаг воронки, ключ сводки). Пусто = имя
    // выводится, как выводилось (Go, domain.questionLabel). Верхний уровень, а не
    // settings: свойство любого отвечаемого блока, а не типа.
    name: z.string().max(MAX_QUESTION_NAME_LEN).optional(),
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
    // Имя — только у отвечаемых: у подписи и контента нет ответов, значит нет ни
    // колонки CSV, ни шага воронки, которые оно называет. Зеркалит Go.
    if (b.name && !isAnswerableType(b.type)) {
      ctx.addIssue({
        code: 'custom',
        message: `тип ${b.type} не собирает ответ и не имеет имени`,
        path: ['name'],
      })
    }
    // column — у любого типа, кроме заголовка формы (canShareRow). Ряд — свойство
    // РАСКЛАДКИ, а не типа: что именно встанет в ряд, решает раскладчик, и поблочная
    // проверка его условий не видит — как не видит и кросс-блочного. Зеркалит Go.
    if (b.settings?.column && !canShareRow(b.type)) {
      ctx.addIssue({
        code: 'custom',
        message: `тип ${b.type} не может делить ряд`,
        path: ['settings', 'column'],
      })
    }

    const settings = b.settings
    if (!settings) return
    const kind = blockKind(b.type)

    // Закреплённые за типом ключи настроек: у чужого типа их наличие — ошибка. До
    // фазы 16 это были три рукописные ветви (картинка, шкала, опции), и четвёртая
    // настройка означала бы четвёртую копию условия. Теперь владение объявляет сам тип
    // (ownSettings в его файле), а инвентарь ключей — settings.ts.
    //
    // Сообщение дедуплицируется по СУЩЕСТВИТЕЛЬНОМУ, а не по ключу: пара
    // scaleMin/scaleMax — одна настройка «шкала», и на чужом типе она обязана давать
    // одно замечание, как давала до фазы.
    const said = new Set<string>()
    for (const { key, noun, present } of OWNED_SETTINGS) {
      if (said.has(noun)) continue
      if (!present(settings[key])) continue
      if (kind.ownSettings.includes(key)) continue
      said.add(noun)
      ctx.addIssue({
        code: 'custom',
        message: `тип ${b.type} не имеет ${noun}`,
        path: ['settings', key],
      })
    }

    // Правила самого типа поверх формы настроек: диапазон шкалы, уникальность id
    // вариантов. Живут в файле типа (blocks/scale.ts, blocks/choice.ts) — это свойство
    // типа, а не документа.
    for (const issue of kind.issues?.(settings) ?? []) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
    }
  })
export type Block = z.infer<typeof blockSchema>

// Документ черновика формы: версия формата и упорядоченный список блоков.
// Отсутствующая schemaVersion трактуется как текущая (дефолт БД '{"blocks":[]}').
export const formSchemaSchema = z
  .strictObject({
    // Опционально: пустой дефолт БД без версии трактуется как текущая; сервер при
    // сохранении канонизирует. Стор билдера всегда шлёт SCHEMA_VERSION явно.
    schemaVersion: z.literal(SCHEMA_VERSION).optional(),
    // Потолок проверяется в superRefine, а не .max(): заголовок формы в счёт не идёт
    // (он часть скелета документа, а не элемент автора) — см. там же.
    blocks: z.array(blockSchema),
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

    // Потолок блоков — зеркало Go: считаем блоки АВТОРА, заголовок формы не в счёт.
    // Иначе форма, собранная до фазы 15 ровно на потолке, после синтеза заголовка
    // получила бы 201 блок и перестала сохраняться совсем.
    const authored = s.blocks.filter((b) => b.type !== 'form_title').length
    if (authored > MAX_BLOCKS) {
      ctx.addIssue({ code: 'custom', message: `больше ${MAX_BLOCKS} блоков`, path: ['blocks'] })
    }

    // Заголовок формы (фаза 15, зеркалит Go validateFormTitle): он один, он первая
    // строка документа и он всегда одиночка. Отсутствие блока законно — версии,
    // опубликованные до v4, заголовка в схеме не несут вовсе.
    const titles = s.blocks.filter((b) => b.type === 'form_title')
    if (titles.length > 1) {
      ctx.addIssue({ code: 'custom', message: 'заголовок формы может быть только один', path: ['blocks'] })
    }
    const title = titles[0]
    if (title) {
      // «Первый» — не косметика: заголовок рисуется как <h1> формы, и блок посреди
      // вопросов означал бы второй <h1> в середине страницы у респондента.
      if (s.blocks[0]?.id !== title.id) {
        ctx.addIssue({
          code: 'custom',
          message: 'заголовок формы должен быть первым блоком',
          path: ['blocks'],
        })
      }
      // Спред, а не .length: Go считает РУНЫ (utf8.RuneCountInString), и на
      // суррогатных парах (эмодзи) .length дал бы вдвое больше — фронт запрещал бы
      // то, что бэкенд принимает.
      if ([...plainText(title.text)].length > MAX_FORM_TITLE_LEN) {
        ctx.addIssue({
          code: 'custom',
          message: `заголовок формы длиннее ${MAX_FORM_TITLE_LEN} символов`,
          path: ['blocks'],
        })
      }
      // Одиночка: попади form_title в группу поля, редактор показал бы заголовок
      // формы подписью вопроса.
      if (s.blocks.some((b) => b.id !== title.id && b.groupId === title.groupId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'заголовок формы не входит в группу вопроса',
          path: ['blocks'],
        })
      }
    }
  })
export type FormSchema = z.infer<typeof formSchemaSchema>
