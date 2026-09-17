import { describe, expect, it } from 'vitest'

import { type ConsentState } from '../../../entities/consent'
import {
  anyConsentInvalid,
  consentDraftFrom,
  consentValue,
  sameConsent,
  validateConsent,
  type ConsentDraft,
} from './consentDraft'

const empty: ConsentState = {
  enabled: false,
  operator: { name: '', inn: '', address: '', email: '' },
  purpose: '',
  retention: '',
  documents: 'template',
  consentText: '',
  policyText: '',
  revisionId: null,
  updatedAt: null,
}

const filled: ConsentDraft = {
  ...consentDraftFrom(empty),
  enabled: true,
  name: 'ООО «Ромашка»',
  address: 'Казань',
  email: 'pd@romashka.ru',
}

describe('черновик согласия', () => {
  it('пробелы по краям однострочных полей — не изменение: сервер их обрежет', () => {
    const withSpaces = { ...filled, name: ' ООО «Ромашка» ', email: 'pd@romashka.ru ' }
    expect(sameConsent(filled, withSpaces)).toBe(true)
    expect(consentValue(withSpaces).operator.name).toBe('ООО «Ромашка»')
  })

  it('переносы в своём тексте — изменение: они часть документа', () => {
    const a = { ...filled, documents: 'custom' as const, consentText: 'абзац' }
    expect(sameConsent(a, { ...a, consentText: 'абзац\n' })).toBe(false)
  })

  it('выключенный раздел законно недозаполнен', () => {
    expect(anyConsentInvalid(validateConsent(consentDraftFrom(empty)))).toBe(false)
  })

  it('включённый с типовыми документами требует реквизиты', () => {
    expect(validateConsent({ ...filled, address: '' }).operatorMissing).toBe(true)
    expect(anyConsentInvalid(validateConsent(filled))).toBe(false)
  })

  it('свои документы реквизитов не требуют, но требуют оба текста', () => {
    const custom = { ...consentDraftFrom(empty), enabled: true, documents: 'custom' as const }
    const invalid = validateConsent(custom)
    expect(invalid.operatorMissing).toBe(false)
    expect(invalid.consentTextMissing).toBe(true)
    expect(invalid.policyTextMissing).toBe(true)
    expect(
      anyConsentInvalid(validateConsent({ ...custom, consentText: 'текст', policyText: 'текст' })),
    ).toBe(false)
  })

  it('ИНН — 10 или 12 цифр, email — адрес; пустые не ошибка', () => {
    expect(validateConsent({ ...filled, inn: '123456789' }).inn).toBe(true)
    expect(validateConsent({ ...filled, inn: '1234567890' }).inn).toBe(false)
    expect(validateConsent({ ...filled, inn: '' }).inn).toBe(false)
    expect(validateConsent({ ...filled, email: 'не адрес' }).email).toBe(true)
  })

  it('неверные реквизиты при своих документах сохранение не держат: их не видно', () => {
    const hidden = {
      ...filled,
      documents: 'custom' as const,
      inn: '123',
      email: 'не адрес',
      consentText: 'согласие',
      policyText: 'политика',
    }
    expect(anyConsentInvalid(validateConsent(hidden))).toBe(false)
  })
})
