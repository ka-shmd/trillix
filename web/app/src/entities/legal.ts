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

export type ConsentKind = 'terms' | 'privacy' | 'marketing'

export interface ConsentChange {
  accept?: { kind: 'terms' | 'marketing'; version: string }[]
  withdraw?: 'marketing'[]
}

// Анкета регистрации. Коды зеркалят CHECK signup_profiles (0071) и signupKinds/
// signupPurposes/signupReferrals в internal/auth/signup.go.
export const SIGNUP_KINDS = [
  { value: 'person', label: 'Частное лицо' },
  { value: 'company', label: 'Компания или ИП' },
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

export interface SignupProfile {
  kind: (typeof SIGNUP_KINDS)[number]['value'] | null
  purpose: (typeof SIGNUP_PURPOSES)[number]['value'] | null
  referral: (typeof SIGNUP_REFERRALS)[number]['value'] | null
}

// profileOf — анкета к отправке; null, если человек не ответил ни на один вопрос: пустую
// строку анкеты заводить незачем.
export function profileOf(a: SignupProfile): SignupProfile | null {
  if (a.kind === null && a.purpose === null && a.referral === null) return null
  return a
}

// legalDocumentPath — адрес публичной страницы документа; с версией — той самой
// редакции.
export function legalDocumentPath(kind: ConsentKind, version?: string): string {
  return `/legal/${kind}` + (version ? `?version=${encodeURIComponent(version)}` : '')
}
