import { z } from 'zod'

// Согласия аккаунта — ответ GET/POST /account/consents (docs/design/signup-consent.md
// §3.5). Подписи галочек присылает сервер: тот же текст ложится в журнал согласий,
// поэтому кабинет свою формулировку не держит.

const offerSchema = z.object({
  version: z.string(),
  title: z.string(),
  effectiveAt: z.string(),
  label: z.string(),
  // Часть label, которая становится ссылкой на документ.
  link: z.string(),
})

export const consentsSchema = z.object({
  // Какой экран закрывает кабинет: регистрация не завершена или вышла существенная
  // редакция соглашения. null — кабинет открыт.
  screen: z.enum(['signup', 'update']).nullable(),
  terms: offerSchema
    .extend({
      acceptedVersion: z.string().nullable(),
      acceptedAt: z.string().nullable(),
    })
    .nullable(),
  marketing: offerSchema
    .extend({
      toggleLabel: z.string(),
      granted: z.boolean(),
      grantedVersion: z.string().nullable(),
      changedAt: z.string().nullable(),
    })
    .nullable(),
  history: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      version: z.string(),
      title: z.string(),
      action: z.enum(['accepted', 'withdrawn']),
      source: z.string(),
      at: z.string(),
    }),
  ),
})

export type Consents = z.infer<typeof consentsSchema>

export const consentKindSchema = z.enum(['terms', 'privacy', 'marketing'])

export type ConsentKind = z.infer<typeof consentKindSchema>

// Документы сервиса — публичные GET /legal/documents и /legal/documents/{kind}
// (docs/design/signup-consent.md §3.4).
export const documentSummarySchema = z.object({
  kind: consentKindSchema,
  title: z.string(),
  version: z.string(),
  effectiveAt: z.string(),
})

export type DocumentSummary = z.infer<typeof documentSummarySchema>

export const documentsSchema = z.object({ items: z.array(documentSummarySchema) })

export const legalDocumentSchema = documentSummarySchema.extend({
  // Абзацы через пустую строку; рендерится текстом (инвариант 4).
  text: z.string(),
  versions: z.array(z.object({ version: z.string(), effectiveAt: z.string() })),
})

export type LegalDocument = z.infer<typeof legalDocumentSchema>

export type DocBlock = { kind: 'heading' | 'paragraph'; text: string }

// docBlocks раскладывает текст документа на заголовки и абзацы. Заголовок — короткий
// абзац в одну строку вида «3. Аккаунт» или «Приложение № 1. …» без точки в конце; пункт
// «3.1. …» и пункт-фраза «8. Поручение действует…» заголовками не становятся. Разметки в
// тексте нет: документ пишется простым текстом (internal/legal/documents).
export function docBlocks(text: string): DocBlock[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => ({ kind: isHeading(p) ? 'heading' : 'paragraph', text: p }))
}

function isHeading(p: string): boolean {
  if (p.includes('\n') || p.length > 90 || /[.;:,]$/.test(p)) return false
  return /^\d+\.\s\S/.test(p) || /^Приложение\s/.test(p)
}

// editionIso — дата редакции (YYYY-MM-DD) как момент по местному времени: formatDate от
// голой даты прочёл бы её полночью UTC и к западу от Гринвича показал бы вчерашний день.
export function editionIso(version: string): string {
  return `${version}T00:00:00`
}

// Реквизиты и адрес для обращений. До юриста и юрлица — заглушки в квадратных скобках,
// как и в текстах документов (docs/design/signup-consent.md §3.4); меняются вместе с ними.
export const SERVICE_OPERATOR = {
  name: '[ИП Фамилия Имя Отчество]',
  details: ['ИНН [000000000000]', 'ОГРНИП [000000000000000]', 'Адрес: [почтовый адрес]'],
  privacyEmail: '[privacy@trillix.ru]',
  legalEmail: '[legal@trillix.ru]',
} as const

// Где человек дал или отозвал согласие — подписи источников журнала (consent_events.source).
export function consentSourceLabel(source: string): string {
  switch (source) {
    case 'signup_password':
    case 'signup_yandex':
      return 'При регистрации'
    case 'update_screen':
      return 'Новая редакция условий'
    case 'settings':
      return 'В правовой информации'
    default:
      return 'Автоматически'
  }
}

export interface ConsentChange {
  accept?: { kind: 'terms' | 'marketing'; version: string }[]
  withdraw?: 'marketing'[]
}

// Анкета регистрации по вкладкам «Частное лицо» и «Компания или ИП» — по образцу WebAsk
// (решение владельца 2026-09-17, docs/design/signup-consent.md §3.3). Коды зеркалят CHECK
// signup_profiles (0071, 0072) и списки в internal/auth/signup.go.
export const SIGNUP_KINDS = [
  { value: 'person', label: 'Частное лицо' },
  { value: 'company', label: 'Компания или ИП' },
] as const

export const SIGNUP_OCCUPATIONS = [
  { value: 'study', label: 'Учусь' },
  { value: 'employed', label: 'Работаю в найме' },
  { value: 'freelance', label: 'Фриланс или самозанятость' },
  { value: 'teaching', label: 'Преподаю' },
  { value: 'science', label: 'Наука и исследования' },
  { value: 'other', label: 'Другое' },
] as const

export const SIGNUP_INDUSTRIES = [
  { value: 'education', label: 'Образование' },
  { value: 'it', label: 'ИТ и разработка' },
  { value: 'marketing', label: 'Маркетинг и реклама' },
  { value: 'healthcare', label: 'Медицина и здоровье' },
  { value: 'retail', label: 'Торговля и интернет-магазины' },
  { value: 'services', label: 'Услуги' },
  { value: 'manufacturing', label: 'Производство' },
  { value: 'finance', label: 'Финансы и страхование' },
  { value: 'public', label: 'Госсектор и некоммерческие организации' },
  { value: 'hr', label: 'Подбор персонала' },
  { value: 'events', label: 'Мероприятия' },
  { value: 'other', label: 'Другое' },
] as const

export const SIGNUP_POSITIONS = [
  { value: 'owner', label: 'Руководитель или собственник' },
  { value: 'marketing', label: 'Маркетинг' },
  { value: 'hr', label: 'Кадры и подбор персонала' },
  { value: 'product', label: 'Управление продуктом или проектами' },
  { value: 'analytics', label: 'Аналитика и исследования' },
  { value: 'teaching', label: 'Преподавание и обучение' },
  { value: 'development', label: 'Разработка' },
  { value: 'other', label: 'Другое' },
] as const

export const SIGNUP_PURPOSES = [
  { value: 'research', label: 'Опросы и исследования' },
  { value: 'leads', label: 'Заявки и лиды' },
  { value: 'events', label: 'Регистрация на мероприятия' },
  { value: 'booking', label: 'Запись клиентов' },
  { value: 'feedback', label: 'Обратная связь' },
  { value: 'quizzes', label: 'Тесты и обучение' },
  { value: 'other', label: 'Другое' },
] as const

export const SIGNUP_REFERRALS = [
  { value: 'search', label: 'Поиск' },
  { value: 'ads', label: 'Реклама' },
  { value: 'social', label: 'Соцсети' },
  { value: 'recommendation', label: 'Посоветовали' },
  { value: 'article', label: 'Статья или обзор' },
  { value: 'other', label: 'Другое' },
] as const

type Code<T extends readonly { value: string }[]> = T[number]['value']

export type SignupKind = Code<typeof SIGNUP_KINDS>

// SignupDraft — анкета, как её держит экран: поля обеих вкладок живут вместе, чтобы
// переключение вкладки не стирало набранное.
export interface SignupDraft {
  kind: SignupKind
  fullName: string
  occupation: Code<typeof SIGNUP_OCCUPATIONS> | null
  profession: string
  companyName: string
  industry: Code<typeof SIGNUP_INDUSTRIES> | null
  jobPosition: Code<typeof SIGNUP_POSITIONS> | null
  purpose: Code<typeof SIGNUP_PURPOSES> | null
  referral: Code<typeof SIGNUP_REFERRALS> | null
}

// SignupProfile — тело PUT /account/signup-profile. null — вопрос пропущен.
export type SignupProfile = Omit<SignupDraft, 'fullName' | 'profession' | 'companyName'> & {
  fullName: string | null
  profession: string | null
  companyName: string | null
}

export function emptySignupDraft(fullName = ''): SignupDraft {
  return {
    kind: 'person',
    fullName,
    occupation: null,
    profession: '',
    companyName: '',
    industry: null,
    jobPosition: null,
    purpose: null,
    referral: null,
  }
}

// signupProfileOf — анкета к отправке: пустые строки становятся «пропущено», поля чужой
// вкладки не уходят. Сервер отбрасывает их и сам, но отправлять то, что человек видит
// скрытым, незачем.
export function signupProfileOf(d: SignupDraft): SignupProfile {
  const text = (v: string) => (v.trim() === '' ? null : v.trim())
  const person = d.kind === 'person'
  return {
    kind: d.kind,
    fullName: text(d.fullName),
    occupation: person ? d.occupation : null,
    profession: person ? text(d.profession) : null,
    companyName: person ? null : text(d.companyName),
    industry: person ? null : d.industry,
    jobPosition: person ? null : d.jobPosition,
    purpose: d.purpose,
    referral: d.referral,
  }
}

// legalDocumentPath — адрес публичной страницы документа; с версией — той самой
// редакции.
export function legalDocumentPath(kind: ConsentKind, version?: string): string {
  return `/legal/${kind}` + (version ? `?version=${encodeURIComponent(version)}` : '')
}
