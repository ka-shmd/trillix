import { describe, expect, it } from 'vitest'

import {
  isDirty,
  redirectValue,
  isoToLocalInput,
  localInputToIso,
  mergeServer,
  pendingChanges,
  validateSettings,
  type SettingsDraft,
} from './draft'

const saved: SettingsDraft = {
  thankYouText: 'Спасибо',
  redirectOn: false,
  redirectUrl: '',
  closeLocal: '',
  limit: '',
  closedMessage: '',
  notify: false,
  partial: false,
  progress: false,
  branding: true,
}

describe('черновик страницы настроек', () => {
  it('нетронутая страница не шлёт ни одного запроса', () => {
    expect(pendingChanges(saved, { ...saved })).toEqual({
      afterSubmit: false,
      close: false,
      notify: false,
      partial: false,
      progress: false,
      branding: false,
    })
    expect(isDirty(saved, { ...saved })).toBe(false)
  })

  it('каждый раздел едет своим запросом и только он', () => {
    expect(pendingChanges(saved, { ...saved, thankYouText: 'Готово' }).afterSubmit).toBe(true)
    expect(pendingChanges(saved, { ...saved, thankYouText: 'Готово' }).close).toBe(false)
    expect(pendingChanges(saved, { ...saved, limit: '10' }).close).toBe(true)
    expect(pendingChanges(saved, { ...saved, notify: true }).notify).toBe(true)
    expect(pendingChanges(saved, { ...saved, partial: true }).partial).toBe(true)
    expect(pendingChanges(saved, { ...saved, progress: true }).progress).toBe(true)
    expect(pendingChanges(saved, { ...saved, branding: false }).branding).toBe(true)
  })

  it('тумблер входит в «есть несохранённое» наравне с полями', () => {
    // Раньше тумблеры сохранялись мгновенно и в dirty-страховку ухода не входили;
    // теперь они часть того же черновика.
    expect(isDirty(saved, { ...saved, notify: true })).toBe(true)
  })

  it('пробелы по краям ссылки и лимита правкой не считаются', () => {
    const draft = { ...saved, redirectOn: true, redirectUrl: '  https://a.com  ' }
    expect(redirectValue(draft)).toBe('https://a.com')
    expect(pendingChanges(saved, { ...saved, limit: '  ' }).close).toBe(false)
  })

  it('выключенный тумблер переадресации отправляет пустую ссылку', () => {
    // Набранный адрес остаётся в черновике (передумавший автор не перепечатывает
    // его), но на сервер уезжает пустая строка — так «переадресации нет» и хранится.
    const draft = { ...saved, redirectOn: false, redirectUrl: 'https://a.com' }
    expect(redirectValue(draft)).toBe('')
    expect(pendingChanges(saved, draft).afterSubmit).toBe(false)
  })

  it('включённый тумблер переадресации требует адрес', () => {
    // Пустое поле и битый адрес — РАЗНЫЕ состояния: сохранение не пропускают оба, но
    // красным помечается только второе. Иначе включённый тумблер сразу ругался бы на
    // поле, в которое человек ещё не печатал.
    const empty = validateSettings({ ...saved, redirectOn: true, redirectUrl: '' })
    expect(empty.urlMissing).toBe(true)
    expect(empty.url).toBe(false)
    expect(validateSettings({ ...saved, redirectOn: true, redirectUrl: 'example.com' }).url).toBe(
      true,
    )
    expect(
      validateSettings({ ...saved, redirectOn: true, redirectUrl: 'https://example.com' }).url,
    ).toBe(false)
    // Выключенный — не требует ничего, даже если в поле осталась ерунда.
    const off = validateSettings({ ...saved, redirectOn: false, redirectUrl: 'ерунда' })
    expect(off.url).toBe(false)
    expect(off.urlMissing).toBe(false)
  })

  it('лимит — целое больше нуля', () => {
    expect(validateSettings({ ...saved, limit: '0' }).limit).toBe(true)
    expect(validateSettings({ ...saved, limit: '1.5' }).limit).toBe(true)
    expect(validateSettings({ ...saved, limit: '100' }).limit).toBe(false)
  })

  it('чужая правка догоняется по одному полю, своя несохранённая — остаётся', () => {
    // Мина, ради которой mergeServer и написан: одна кнопка шлёт несколько
    // запросов, и часть может провалиться. Здесь схема сохранилась (сервер отдал
    // новый текст), а закрытие — нет: правка лимита обязана уцелеть.
    const draft = { ...saved, thankYouText: 'Готово', limit: '10' }
    const next = { ...saved, thankYouText: 'Готово' }
    expect(mergeServer(draft, saved, next)).toEqual({ ...next, limit: '10' })
  })

  it('дата закрытия ходит туда-обратно через локальное время', () => {
    const local = isoToLocalInput(new Date('2026-08-29T10:30:00Z').toISOString())
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(localInputToIso(local)).toBe('2026-08-29T10:30:00.000Z')
    expect(isoToLocalInput(null)).toBe('')
    expect(localInputToIso('')).toBeNull()
  })
})
