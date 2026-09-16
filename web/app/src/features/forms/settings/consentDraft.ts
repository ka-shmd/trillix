import { z } from 'zod'

import { type ConsentSettings, type ConsentState } from '../../../entities/consent'

// Черновик раздела «Персональные данные» (docs/design/privacy-consent.md). Живёт рядом
// с черновиком страницы (draft.ts), но отдельно от него: данные раздела приезжают
// своей ручкой и уезжают одним запросом целиком, поэтому и сверка у него своя.
//
// Плоский, а не вложенный: поля правятся по одному, и плоская запись — это `set` по
// ключу, как у остальной страницы.
export interface ConsentDraft {
  enabled: boolean
  name: string
  inn: string
  address: string
  email: string
  purpose: string
  retention: string
  consentMode: 'template' | 'custom'
  consentText: string
  policyMode: 'template' | 'custom'
  policyText: string
}

export function consentDraftFrom(state: ConsentState): ConsentDraft {
  return {
    enabled: state.enabled,
    name: state.operator.name,
    inn: state.operator.inn,
    address: state.operator.address,
    email: state.operator.email,
    purpose: state.purpose,
    retention: state.retention,
    consentMode: state.consent.mode,
    consentText: state.consent.text,
    policyMode: state.policy.mode,
    policyText: state.policy.text,
  }
}

// consentSettingsValue — настройки в теле запроса. Однострочные поля обрезаются так
// же, как их обрежет сервер: иначе пробел в конце адреса держал бы страницу
// «несохранённой» после сохранения. Тексты документов не трогаются — переносы в них
// часть документа.
export function consentSettingsValue(d: ConsentDraft): ConsentSettings {
  return {
    operator: {
      name: d.name.trim(),
      inn: d.inn.trim(),
      address: d.address.trim(),
      email: d.email.trim(),
    },
    purpose: d.purpose.trim(),
    retention: d.retention.trim(),
    consent: { mode: d.consentMode, text: d.consentText },
    policy: { mode: d.policyMode, text: d.policyText },
  }
}

export function consentValue(d: ConsentDraft): ConsentSettings & { enabled: boolean } {
  return { enabled: d.enabled, ...consentSettingsValue(d) }
}

export function sameConsent(a: ConsentDraft, b: ConsentDraft): boolean {
  return JSON.stringify(consentValue(a)) === JSON.stringify(consentValue(b))
}

// Недозаполненное и неверное — разные флаги: незаконченность кнопку держит молча,
// а неверный формат краснеет (то же деление, что у остальной страницы).
export interface ConsentInvalid {
  operatorMissing: boolean
  consentTextMissing: boolean
  policyTextMissing: boolean
  inn: boolean
  email: boolean
}

const emailCheck = z.email()

// validateConsent зеркалит ValidateConsentSettings (internal/domain/consent.go):
// обязательность — только у включённого согласия, реквизиты — только если хоть один
// документ типовой.
export function validateConsent(d: ConsentDraft): ConsentInvalid {
  const v = consentSettingsValue(d)
  const needsOperator = d.enabled && (d.consentMode === 'template' || d.policyMode === 'template')
  return {
    operatorMissing:
      needsOperator &&
      (v.operator.name === '' || v.operator.address === '' || v.operator.email === ''),
    consentTextMissing: d.enabled && d.consentMode === 'custom' && d.consentText.trim() === '',
    policyTextMissing: d.enabled && d.policyMode === 'custom' && d.policyText.trim() === '',
    inn: v.operator.inn !== '' && !/^(\d{10}|\d{12})$/.test(v.operator.inn),
    email: v.operator.email !== '' && !emailCheck.safeParse(v.operator.email).success,
  }
}

export function anyConsentInvalid(i: ConsentInvalid): boolean {
  return i.operatorMissing || i.consentTextMissing || i.policyTextMissing || i.inn || i.email
}
