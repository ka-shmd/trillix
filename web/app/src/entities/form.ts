import { z } from 'zod'

import { formSchemaSchema } from '@entities/formSchema'

// Доменные типы форм. Единственный источник — эти Zod-схемы (web/CLAUDE.md),
// зеркалят DTO из internal/forms/handler.go. Черновик схемы (draftSchema)
// парсится общим с рендерером formSchemaSchema прямо на границе API.
export const formStatusSchema = z.enum(['draft', 'published', 'closed'])

// Карточка формы в списке и ответ создания/переименования.
export const formSchema = z.object({
  id: z.string(),
  // name — внутреннее имя для дашборда (null = не задано → показываем по title).
  // title — публичный заголовок формы, его видит респондент (ADR §10).
  name: z.string().nullable(),
  title: z.string(),
  slug: z.string(),
  status: formStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  // Публикация (фаза 4). publishedVersion/publishedVersionId — null, пока форму
  // не публиковали (после закрытия сохраняются). hasUnpublishedChanges — черновик
  // разошёлся с опубликованной версией (бейдж в шапке билдера); точен на
  // GET/списке, у ответов мутаций всегда false.
  publishedVersion: z.number().int().nullable(),
  publishedVersionId: z.string().nullable(),
  hasUnpublishedChanges: z.boolean(),
  // Число ответов формы (счётчик на карточке). Точен на GET/списке; у ответов
  // мутаций всегда 0 (карточка обновляется из списка).
  submissionCount: z.number().int(),
  // Просмотры формы и сколько из них закончились ответом (фаза 8.5 шаг 6).
  // Конверсия = visitSubmittedCount / visitCount; делить submissionCount на
  // visitCount нельзя — это разные множества (ответ мог прийти без визита, ADR §10).
  // Точны на GET/списке; у ответов мутаций 0.
  visitCount: z.number().int(),
  visitSubmittedCount: z.number().int(),
})

export type Form = z.infer<typeof formSchema>

// Дефолт названия с бэкенда (internal/forms/service.go) для формы без имени. В UI
// показываем его как «Без названия» (плейсхолдер), а не как введённый текст.
export const DEFAULT_FORM_TITLE = 'Untitled form'

const isUntitled = (title: string): boolean =>
  title.trim() === '' || title === DEFAULT_FORM_TITLE

// Заголовок формы для показа: плейсхолдер для безымянной, иначе сам title.
export const displayFormTitle = (title: string): string =>
  isUntitled(title) ? 'Без названия' : title

// Отображаемое имя формы в кабинете (дашборд, таблица ответов): внутреннее имя,
// если задано, иначе — показ по публичному заголовку (фолбэк, ADR §10).
export const displayFormName = (form: { name: string | null; title: string }): string =>
  form.name && form.name.trim() !== '' ? form.name : displayFormTitle(form.title)

// Карточка ссылки — то, что рисуют мессенджеры и соцсети, получив адрес формы.
// Каждое поле независимо, пустая строка = «взять дефолт» (заголовок формы, тизер
// из подписей вопросов, брендовая картинка), а не «показать пустоту». Зеркалит
// linkPreviewBody из internal/forms/handler.go.
export const linkPreviewSchema = z.object({
  siteName: z.string(),
  title: z.string(),
  description: z.string(),
  // Ключи объектов в бакете медиа, а не URL: адрес собирается из ключа (mediaSrc).
  imageKey: z.string(),
  iconKey: z.string(),
})

export type LinkPreview = z.infer<typeof linkPreviewSchema>

// Потолки полей карточки (рун) — зеркалят domain.MaxLinkPreview*Len.
export const MAX_LINK_PREVIEW_SITE_NAME_LEN = 100
export const MAX_LINK_PREVIEW_TITLE_LEN = 200
export const MAX_LINK_PREVIEW_DESCRIPTION_LEN = 500

// Пустая карточка — то же, что её отсутствие: сервер хранит NULL и отдаёт null.
export const EMPTY_LINK_PREVIEW: LinkPreview = {
  siteName: '',
  title: '',
  description: '',
  imageKey: '',
  iconKey: '',
}

// GET /forms/{id}: карточка + черновик схемы (билдер гидрирует им свой стор) +
// живые настройки закрытия (страница настроек; фаза 8.5 шаг 4).
export const formDetailSchema = formSchema.extend({
  draftSchema: formSchemaSchema,
  // null/пусто = ограничение не задано. closeAt — ISO-строка момента закрытия;
  // responseLimit — жёсткий лимит принятых ответов; closedMessage — текст экрана
  // «приём закрыт» (null → дефолт рендерера).
  closeAt: z.string().nullable(),
  responseLimit: z.number().int().nullable(),
  closedMessage: z.string().nullable(),
  // Слать ли владельцу письмо о новом ответе (слайс D). Новые формы — true.
  notifyOnSubmission: z.boolean(),
  // Собирать ли незавершённые ответы. Новые формы — false: сбор того, что человек
  // не отправлял, по умолчанию не включается. Включение требует платного тарифа
  // (единственный гейт продукта, стоящий на сборе, а не на показе).
  collectPartial: z.boolean(),
  // Своя карточка ссылки; null = не настраивали. Отдаётся независимо от тарифа —
  // окно кастомизации показывает сохранённое всем, а к самой ссылке карточку
  // применяет публичный слой (гейт стоит там, как у бейджа).
  linkPreview: linkPreviewSchema.nullable(),
})

export type FormDetail = z.infer<typeof formDetailSchema>

// Потолок текста экрана «приём закрыт» (рун) — зеркалит domain.MaxClosedMessageLen.
export const MAX_CLOSED_MESSAGE_LEN = 2000

// Настройки закрытия для отправки в PATCH (фасет closeSettings). Полный набор:
// отсутствующее/пустое поле = ограничение снято. closedMessage — всегда строка
// (пустая = дефолт), closeAt/responseLimit — null снимает ограничение.
export type CloseSettingsInput = {
  closeAt: string | null
  responseLimit: number | null
  closedMessage: string
}

// GET /forms: страница + непрозрачный курсор на следующую (null — последняя).
export const formsPageSchema = z.object({
  forms: z.array(formSchema),
  nextCursor: z.string().nullable(),
})

export type FormsPage = z.infer<typeof formsPageSchema>

// Порядок списка форм (фаза 8.5 шаг 8). Зеркало белого списка сервера
// (forms.ParseSortOrder): значение уходит в query-параметр sort, чужое сервер
// отвергает 422. Схема нужна не только для типа: ею валидируется sort из АДРЕСНОЙ
// СТРОКИ — её правит человек, и мусор оттуда не должен доезжать до запроса.
export const formsSortSchema = z.enum(['updated', 'created', 'responses'])
export type FormsSort = z.infer<typeof formsSortSchema>

export const DEFAULT_FORMS_SORT: FormsSort = 'updated'

// Подписи для селектора — рядом со схемой, чтобы новый порядок нельзя было
// завести, забыв про его название на экране.
export const FORMS_SORT_LABELS: Record<FormsSort, string> = {
  updated: 'По дате изменения',
  created: 'По дате создания',
  responses: 'По числу ответов',
}
