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
  documents: 'template' | 'custom'
  consentText: string
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
    documents: state.documents,
    consentText: state.consentText,
    policyText: state.policyText,
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
    documents: d.documents,
    consentText: d.consentText,
    policyText: d.policyText,
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
// проверяются только поля выбранного источника документов — поля другого скрыты, и
// ошибка в них держала бы сохранение без способа её исправить. Обязательность —
// только у включённого согласия.
export function validateConsent(d: ConsentDraft): ConsentInvalid {
  const v = consentSettingsValue(d)
  const template = d.documents === 'template'
  const custom = d.enabled && !template
  return {
    operatorMissing:
      d.enabled &&
      template &&
      (v.operator.name === '' || v.operator.address === '' || v.operator.email === ''),
    consentTextMissing: custom && d.consentText.trim() === '',
    policyTextMissing: custom && d.policyText.trim() === '',
    inn: template && v.operator.inn !== '' && !/^(\d{10}|\d{12})$/.test(v.operator.inn),
    email: template && v.operator.email !== '' && !emailCheck.safeParse(v.operator.email).success,
  }
}

export function anyConsentInvalid(i: ConsentInvalid): boolean {
  return i.operatorMissing || i.consentTextMissing || i.policyTextMissing || i.inn || i.email
}
