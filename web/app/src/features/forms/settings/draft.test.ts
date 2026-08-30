import { describe, expect, it } from 'vitest'

import {
  closeSettingsValue,
  isDirty,
  notifyEmailValue,
  settingsFromForm,
  redirectValue,
  isoToLocalInput,
  localInputToIso,
  mergeServer,
  pendingChanges,
  validateSettings,
  type SettingsDraft,
} from './draft'
import { newFormDetail } from '../draft'

const saved: SettingsDraft = {
  thankYouText: 'Спасибо',
  redirectOn: false,
  redirectUrl: '',
  closedNow: false,
  closeOn: false,
  closeLocal: '',
  limitOn: false,
  limit: '',
  closedMessageOn: false,
  closedTitle: '',
  closedMessage: '',
  notify: false,
  notifyFromName: '',
  notifyReplyTo: '',
  notifySubject: '',
  notifyBody: '',
  notifyAttachPdf: false,
  partial: false,
  progress: false,
  branding: true,
  autoJump: false,
  saveLocally: false,
}

// Письмо по умолчанию, каким его отдаёт сервер: имя отправителя и тема стоят в
// бланке настоящим текстом, а на провод уезжают пустыми.
const defaultMail = {
  from: 'no-reply@trillix.ru',
  to: 'owner@example.com',
  fromName: 'Trillix',
  subject: 'Новый ответ в Trillix',
}

describe('черновик страницы настроек', () => {
  it('нетронутая страница не шлёт ни одного запроса', () => {
    expect(pendingChanges(saved, { ...saved })).toEqual({
      afterSubmit: false,
      close: false,
      closedNow: false,
      notify: false,
      notifyEmail: false,
      partial: false,
      progress: false,
      branding: false,
      behavior: false,
    })
    expect(isDirty(saved, { ...saved })).toBe(false)
  })

  it('каждый раздел едет своим запросом и только он', () => {
    expect(pendingChanges(saved, { ...saved, thankYouText: 'Готово' }).afterSubmit).toBe(true)
    expect(pendingChanges(saved, { ...saved, thankYouText: 'Готово' }).close).toBe(false)
    expect(pendingChanges(saved, { ...saved, limitOn: true, limit: '10' }).close).toBe(true)
    expect(pendingChanges(saved, { ...saved, closedNow: true }).closedNow).toBe(true)
    expect(pendingChanges(saved, { ...saved, notify: true }).notify).toBe(true)
    expect(pendingChanges(saved, { ...saved, partial: true }).partial).toBe(true)
    expect(pendingChanges(saved, { ...saved, progress: true }).progress).toBe(true)
    expect(pendingChanges(saved, { ...saved, branding: false }).branding).toBe(true)
    expect(pendingChanges(saved, { ...saved, notifySubject: 'Заявка' }).notifyEmail).toBe(true)
    expect(pendingChanges(saved, { ...saved, autoJump: true }).behavior).toBe(true)
    expect(pendingChanges(saved, { ...saved, saveLocally: true }).behavior).toBe(true)
  })

  it('тумблер входит в «есть несохранённое» наравне с полями', () => {
    // Тумблер — часть того же черновика, что и поля: он входит в dirty-страховку
    // ухода со страницы, а не сохраняется сам по переключению.
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

  it('Reply-To проверяется как адрес, пустой — законное «не настраивал»', () => {
    expect(validateSettings({ ...saved, notifyReplyTo: 'hr@example.com' }).replyTo).toBe(false)
    expect(validateSettings({ ...saved, notifyReplyTo: 'hr@' }).replyTo).toBe(true)
    expect(validateSettings({ ...saved, notifyReplyTo: '' }).replyTo).toBe(false)
  })

  it('в письмо уезжают обрезанные поля, но текст — как набран', () => {
    // Пробелы по краям текста письма — часть письма: абзац, начатый с отступа,
    // автор написал намеренно. У имени, адреса и темы они всегда опечатка.
    const value = notifyEmailValue(
      {
        ...saved,
        notifyFromName: '  Отдел кадров ',
        notifyReplyTo: ' hr@example.com ',
        notifySubject: ' Заявка ',
        notifyBody: '  Здравствуйте!  ',
      },
      defaultMail,
    )
    expect(value).toEqual({
      fromName: 'Отдел кадров',
      replyTo: 'hr@example.com',
      subject: 'Заявка',
      body: '  Здравствуйте!  ',
      attachPdf: false,
    })
  })

  it('вложение PDF — часть настройки письма и едет тем же запросом', () => {
    // Отдельной мутации у чекбокса нет: он живёт в письме, а не рядом с ним, —
    // иначе одна кнопка страницы посылала бы седьмой запрос ради одного булева.
    expect(notifyEmailValue({ ...saved, notifyAttachPdf: true }, defaultMail).attachPdf).toBe(true)
    expect(pendingChanges(saved, { ...saved, notifyAttachPdf: true }).notifyEmail).toBe(true)
  })

  it('нетронутые имя отправителя и тема стоят в бланке текстом письма', () => {
    // Поле показывает то, что уйдёт в письме, а не подсказку о том, что туда писать.
    const form = { ...newFormDetail(), notifyMail: defaultMail }
    const draft = settingsFromForm(form)
    expect(draft.notifyFromName).toBe('Trillix')
    expect(draft.notifySubject).toBe('Новый ответ в Trillix')

    // Своё письмо сильнее умолчания.
    const own = settingsFromForm({
      ...form,
      notifyEmail: {
        fromName: '',
        replyTo: '',
        subject: 'Заявка с сайта',
        body: '',
        attachPdf: false,
      },
    })
    expect(own.notifySubject).toBe('Заявка с сайта')
    // Пустое поле в своей настройке — по-прежнему умолчание, а не пустая строка.
    expect(own.notifyFromName).toBe('Trillix')
  })

  it('нетронутые имя отправителя и тема уезжают пустыми, а не текстом шаблона', () => {
    // Иначе сегодняшний текст шаблона замёрз бы в колонке: правка шаблона перестала
    // бы доезжать до всех, кто когда-либо открывал страницу и нажимал «Сохранить».
    const value = notifyEmailValue(
      { ...saved, notifyFromName: 'Trillix', notifySubject: 'Новый ответ в Trillix' },
      defaultMail,
    )
    expect(value.fromName).toBe('')
    expect(value.subject).toBe('')
    // Переписанное — уезжает как есть.
    const own = notifyEmailValue({ ...saved, notifySubject: 'Заявка с сайта' }, defaultMail)
    expect(own.subject).toBe('Заявка с сайта')
  })

  it('включённый лимит требует целое больше нуля, выключенный — ничего', () => {
    expect(validateSettings({ ...saved, limitOn: true, limit: '0' }).limit).toBe(true)
    expect(validateSettings({ ...saved, limitOn: true, limit: '1.5' }).limit).toBe(true)
    expect(validateSettings({ ...saved, limitOn: true, limit: '' }).limit).toBe(true)
    expect(validateSettings({ ...saved, limitOn: true, limit: '100' }).limit).toBe(false)
    expect(validateSettings({ ...saved, limitOn: false, limit: 'ерунда' }).limit).toBe(false)
  })

  it('выключенные тумблеры доступности снимают ограничения, а не хранят набранное', () => {
    // Набранное остаётся в черновике (передумавший автор не перепечатывает), но на
    // сервер уезжает снятое ограничение — иначе выключенный тумблер лгал бы.
    const draft = {
      ...saved,
      closeOn: false,
      closeLocal: '2026-09-01T12:00',
      limitOn: false,
      limit: '10',
      closedMessageOn: false,
      closedTitle: 'Всё',
      closedMessage: 'Спасибо',
    }
    expect(closeSettingsValue(draft)).toEqual({
      closeAt: null,
      responseLimit: null,
      closedTitle: '',
      closedMessage: '',
    })
    expect(pendingChanges(saved, draft).close).toBe(false)
  })

  it('включённое закрытие по дате требует саму дату', () => {
    expect(validateSettings({ ...saved, closeOn: true, closeLocal: '' }).closeAt).toBe(true)
    expect(
      validateSettings({ ...saved, closeOn: true, closeLocal: '2026-09-01T12:00' }).closeAt,
    ).toBe(false)
    expect(validateSettings({ ...saved, closeOn: false, closeLocal: '' }).closeAt).toBe(false)
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
