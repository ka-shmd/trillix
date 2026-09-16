import { z } from 'zod'

// Раздел «Персональные данные» формы: согласие на обработку персональных данных под
// кнопкой отправки (docs/design/privacy-consent.md, API.md `/forms/{id}/consent`).

// Потолки полей в символах. Зеркалят Max* в internal/domain/consent.go — сверяет
// consent_parity_test.go.
export const MAX_CONSENT_OPERATOR_NAME_LEN = 300
export const MAX_CONSENT_OPERATOR_ADDRESS_LEN = 500
export const MAX_CONSENT_EMAIL_LEN = 254
export const MAX_CONSENT_PURPOSE_LEN = 1000
export const MAX_CONSENT_RETENTION_LEN = 500
export const MAX_CONSENT_DOC_TEXT_LEN = 60000

// template — типовой текст из реквизитов, custom — свой текст автора.
export const consentDocSchema = z.object({
  mode: z.enum(['template', 'custom']),
  text: z.string(),
})
export type ConsentDoc = z.infer<typeof consentDocSchema>

export const consentSettingsSchema = z.object({
  operator: z.object({
    name: z.string(),
    inn: z.string(),
    address: z.string(),
    email: z.string(),
  }),
  // Пусто — формулировка типового текста по умолчанию.
  purpose: z.string(),
  retention: z.string(),
  consent: consentDocSchema,
  policy: consentDocSchema,
})
export type ConsentSettings = z.infer<typeof consentSettingsSchema>

export const consentStateSchema = consentSettingsSchema.extend({
  enabled: z.boolean(),
  // Текущая ревизия; null — раздел не сохраняли.
  revisionId: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type ConsentState = z.infer<typeof consentStateSchema>

const consentDocumentSchema = z.object({ title: z.string(), text: z.string() })

export const consentPreviewSchema = z.object({
  consent: consentDocumentSchema,
  policy: consentDocumentSchema,
})
export type ConsentPreview = z.infer<typeof consentPreviewSchema>
