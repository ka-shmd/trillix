import { describe, expect, it } from 'vitest'

import { consentSourceLabel, docBlocks, editionIso, emptySignupDraft, signupProfileOf } from './legal'
import { formatDate } from '../shared/format'

describe('docBlocks', () => {
  it('заголовок — короткий нумерованный абзац без точки в конце, пункты — абзацы', () => {
    const text = [
      'Вступление.',
      '1. Термины',
      '1.1. Сервис — программный комплекс.',
      '8. Поручение действует в течение срока действия Соглашения.',
      'Приложение № 1. Поручение на обработку персональных данных',
      '[ИП Фамилия]\nИНН [000]',
    ].join('\n\n')
    expect(docBlocks(text)).toEqual([
      { kind: 'paragraph', text: 'Вступление.' },
      { kind: 'heading', text: '1. Термины' },
      { kind: 'paragraph', text: '1.1. Сервис — программный комплекс.' },
      { kind: 'paragraph', text: '8. Поручение действует в течение срока действия Соглашения.' },
      { kind: 'heading', text: 'Приложение № 1. Поручение на обработку персональных данных' },
      { kind: 'paragraph', text: '[ИП Фамилия]\nИНН [000]' },
    ])
  })

  // Зеркало текстов internal/legal/documents: правило заголовка держится на том, как они
  // написаны, и расходится молча — страница покажет раздел абзацем или пункт заголовком.
  it('на настоящем тексте соглашения: заголовки — разделы и приложение, пунктов среди них нет', () => {
    const files = import.meta.glob<string>('../../../../internal/legal/documents/terms/*.txt', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const latest = Object.keys(files).sort().at(-1)
    expect(latest).toBeDefined()
    const headings = docBlocks(files[latest ?? ''] ?? '')
      .filter((b) => b.kind === 'heading')
      .map((b) => b.text)
    expect(headings).toContain('1. Термины')
    expect(headings.at(-1)).toMatch(/^Приложение № 1\./)
    expect(headings.every((h) => !/^\d+\.\d/.test(h))).toBe(true)
    expect(headings.length).toBeGreaterThanOrEqual(10)
  })
})

describe('editionIso', () => {
  it('дата редакции остаётся тем же днём при любом поясе браузера', () => {
    expect(formatDate(editionIso('2026-09-17'))).toBe(formatDate('2026-09-17T12:00:00'))
  })
})

describe('consentSourceLabel', () => {
  it.each([
    ['signup_password', 'При регистрации'],
    ['signup_yandex', 'При регистрации'],
    ['update_screen', 'Новая редакция условий'],
    ['settings', 'В правовой информации'],
    ['seed', 'Автоматически'],
  ])('%s → %s', (source, label) => {
    expect(consentSourceLabel(source)).toBe(label)
  })
})

describe('signupProfileOf', () => {
  it('частное лицо: пробелы обрезаны, пустое — пропущено, поля компании не уходят', () => {
    const draft = {
      ...emptySignupDraft('  Иван  ', '   '),
      profession: '   ',
      occupation: 'study' as const,
      companyName: 'ООО «Ромашка»',
      industry: 'it' as const,
      jobPosition: 'owner' as const,
      purpose: 'leads' as const,
    }
    // Пустая фамилия — пустая строка, а не null: для профиля аккаунта это «стереть».
    expect(signupProfileOf(draft)).toEqual({
      firstName: 'Иван',
      lastName: '',
      kind: 'person',
      occupation: 'study',
      profession: null,
      companyName: null,
      industry: null,
      jobPosition: null,
      purpose: 'leads',
      referral: null,
    })
  })

  it('компания: поля частного лица не уходят', () => {
    const draft = {
      ...emptySignupDraft('Иван', 'Иванов'),
      kind: 'company' as const,
      occupation: 'study' as const,
      profession: 'дизайнер',
      companyName: ' ИП Иванов И. И. ',
      industry: 'services' as const,
    }
    expect(signupProfileOf(draft)).toMatchObject({
      kind: 'company',
      companyName: 'ИП Иванов И. И.',
      industry: 'services',
      occupation: null,
      profession: null,
    })
  })
})
