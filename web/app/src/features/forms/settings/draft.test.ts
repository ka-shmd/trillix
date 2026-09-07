import { describe, expect, it } from 'vitest'

import { plainText, textFromString } from '@entities/formSchema'

import {
  closeSettingsValue,
  isDirty,
  firstEmailQuestion,
  notifyEmailValue,
  respondentEmailValue,
  settingsFromForm,
  redirectValue,
  isoToLocalInput,
  localInputToIso,
  mergeServer,
  passwordValue,
  pendingChanges,
  validateSettings,
  type SettingsDraft,
} from './draft'
import { newFormDetail } from '../draft'
import { type FormDetail } from '../../../entities/form'

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
  notifySubject: [],
  notifyBody: [],
  notifyAttachPdf: false,
  passwordOn: false,
  password: '',
  respondentOn: false,
  respondentSource: '',
  respondentFromName: '',
  respondentReplyTo: '',
  respondentSubject: [],
  respondentBody: [],
  respondentAttachPdf: false,
  partial: false,
  progress: false,
  branding: true,
  autoJump: false,
  saveLocally: false,
  allowBack: false,
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
      respondent: false,
      respondentEmail: false,
      partial: false,
      password: false,
      progress: false,
      branding: false,
      behavior: false,
    })
    expect(isDirty(saved, { ...saved })).toBe(false)
  })

  // Пароль на форму (0047): тумблер плюс значение, как переадресация и лимит.
  it('пароль: тумблер без значения не сохраняется, значение уезжает своим запросом', () => {
    // Включённый тумблер с пустым полем — незаконченная настройка, а не «пароля нет».
    expect(validateSettings({ ...saved, passwordOn: true }).passwordMissing).toBe(true)
    expect(validateSettings({ ...saved, passwordOn: true, password: 'x' }).passwordMissing).toBe(
      false,
    )
    expect(
      validateSettings({ ...saved, passwordOn: true, password: 'я'.repeat(129) }).passwordLong,
    ).toBe(true)

    const withPassword = { ...saved, passwordOn: true, password: 'секрет' }
    expect(pendingChanges(saved, withPassword).password).toBe(true)
    // И только он: пароль не тянет за собой соседние запросы.
    expect(pendingChanges(saved, withPassword).close).toBe(false)
    expect(passwordValue(withPassword)).toBe('секрет')

    // Выключенный тумблер = снять пароль (null), даже если поле не стёрли.
    expect(passwordValue({ ...withPassword, passwordOn: false })).toBeNull()
    // Пробелы по краям не режутся: это ровно та строка, которую автор разослал.
    expect(passwordValue({ ...saved, passwordOn: true, password: ' два ' })).toBe(' два ')
  })

  // Выключенный тумблер и пустое поле дают ОДИН И ТОТ ЖЕ запрос — страница не имеет
  // права считаться несохранённой из-за набранного и стёртого пароля.
  it('пароль: пустое значение при выключенном тумблере — не правка', () => {
    const savedWithoutPassword = { ...saved, passwordOn: false, password: '' }
    const typedThenErased = { ...saved, passwordOn: false, password: 'набрал и стёр тумблер' }
    expect(pendingChanges(savedWithoutPassword, typedThenErased).password).toBe(false)
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
    expect(
      pendingChanges(saved, { ...saved, notifySubject: textFromString('Заявка') }).notifyEmail,
    ).toBe(true)
    // Спаны сравниваются ПО ЗНАЧЕНИЮ: свежий массив с тем же содержимым правкой не
    // является, иначе страница осталась бы вечно несохранённой.
    expect(
      pendingChanges(
        { ...saved, notifyBody: textFromString('Текст') },
        { ...saved, notifyBody: textFromString('Текст') },
      ).notifyEmail,
    ).toBe(false)
    expect(pendingChanges(saved, { ...saved, autoJump: true }).behavior).toBe(true)
    expect(pendingChanges(saved, { ...saved, saveLocally: true }).behavior).toBe(true)
    expect(pendingChanges(saved, { ...saved, allowBack: true }).behavior).toBe(true)
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
        notifySubject: textFromString('Заявка'),
        notifyBody: textFromString('  Здравствуйте!  '),
      },
      defaultMail,
    )
    expect(value).toEqual({
      fromName: 'Отдел кадров',
      replyTo: 'hr@example.com',
      subject: textFromString('Заявка'),
      body: textFromString('  Здравствуйте!  '),
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
    expect(plainText(draft.notifySubject)).toBe('Новый ответ в Trillix')

    // Своё письмо сильнее умолчания.
    const own = settingsFromForm({
      ...form,
      notifyEmail: {
        fromName: '',
        replyTo: '',
        subject: textFromString('Заявка с сайта'),
        body: [],
        attachPdf: false,
      },
    })
    expect(plainText(own.notifySubject)).toBe('Заявка с сайта')
    // Пустое поле в своей настройке — по-прежнему умолчание, а не пустая строка.
    expect(own.notifyFromName).toBe('Trillix')
  })

  it('нетронутые имя отправителя и тема уезжают пустыми, а не текстом шаблона', () => {
    // Иначе сегодняшний текст шаблона замёрз бы в колонке: правка шаблона перестала
    // бы доезжать до всех, кто когда-либо открывал страницу и нажимал «Сохранить».
    const value = notifyEmailValue(
      {
        ...saved,
        notifyFromName: 'Trillix',
        notifySubject: textFromString('Новый ответ в Trillix'),
      },
      defaultMail,
    )
    expect(value.fromName).toBe('')
    expect(value.subject).toEqual([])
    // Переписанное — уезжает как есть.
    const own = notifyEmailValue(
      { ...saved, notifySubject: textFromString('Заявка с сайта') },
      defaultMail,
    )
    expect(plainText(own.subject)).toBe('Заявка с сайта')
    // ЧИП в теме умолчанием не считается, даже если его имя совпало с текстом шаблона
    // по буквам: подстановка — правка автора, и стереть её как «ничего не менял» нельзя.
    const chip = notifyEmailValue(
      { ...saved, notifySubject: [{ t: 'Новый ответ в Trillix', ref: 'b1' }] },
      defaultMail,
    )
    expect(chip.subject).toHaveLength(1)
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

// Бланк письма респонденту: источник уезжает как есть, а имя отправителя и тема,
// равные умолчанию письма, уезжают ПУСТЫМИ — иначе сегодняшний текст шаблона
// заморозился бы в колонке и правка шаблона перестала бы доезжать до автора.
describe('respondentEmailValue', () => {
  const mail = {
    from: 'no-reply@trillix.ru',
    to: '',
    fromName: 'Trillix',
    subject: 'Ваш ответ получен',
  }

  it('нетронутый бланк уезжает пустым, кроме источника', () => {
    const draft: SettingsDraft = {
      ...saved,
      respondentSource: 'blk_mail',
      respondentFromName: 'Trillix',
      respondentSubject: textFromString('Ваш ответ получен'),
    }
    expect(respondentEmailValue(draft, mail)).toEqual({
      sourceBlockId: 'blk_mail',
      fromName: '',
      replyTo: '',
      subject: [],
      body: [],
      attachPdf: false,
    })
  })

  it('переписанные имя и тема уезжают своими', () => {
    const draft: SettingsDraft = {
      ...saved,
      respondentSource: 'blk_mail',
      respondentFromName: '  Анкета  ',
      respondentSubject: textFromString('Спасибо!'),
      respondentAttachPdf: true,
    }
    const value = respondentEmailValue(draft, mail)
    expect(value.fromName).toBe('Анкета')
    expect(plainText(value.subject)).toBe('Спасибо!')
    expect(value.attachPdf).toBe(true)
  })

  // Чип подстановки в теме — правка автора, даже если его имя совпало с текстом
  // шаблона по буквам: стереть её как «ничего не менял» нельзя.
  it('чип в теме не считается умолчанием', () => {
    const draft: SettingsDraft = {
      ...saved,
      respondentSubject: [{ t: 'Ваш ответ получен', ref: 'b1' }],
    }
    expect(respondentEmailValue(draft, mail).subject).toHaveLength(1)
  })
})

// Бланк респондента проверяется теми же тремя правилами, что бланк владельца, и
// СВОИМИ полями: перепутанные поля означали бы, что ошибка подсвечивается в чужой
// коробке.
describe('validateSettings письма респонденту', () => {
  it('битый Reply-To и переборы длины', () => {
    const invalid = validateSettings({
      ...saved,
      respondentReplyTo: 'не адрес',
      respondentSubject: textFromString('т'.repeat(201)),
      respondentBody: textFromString('т'.repeat(2001)),
    })
    expect(invalid.respondentReplyTo).toBe(true)
    expect(invalid.respondentSubjectLong).toBe(true)
    expect(invalid.respondentBodyLong).toBe(true)
    // Поля письма ВЛАДЕЛЬЦУ при этом чисты: две коробки не делят подсветку.
    expect(invalid.replyTo).toBe(false)
    expect(invalid.notifySubjectLong).toBe(false)
  })

  it('пустой бланк валиден', () => {
    const invalid = validateSettings(saved)
    expect(invalid.respondentReplyTo).toBe(false)
    expect(invalid.respondentSubjectLong).toBe(false)
    expect(invalid.respondentBodyLong).toBe(false)
  })
})

// Тумблер и бланк — два РАЗНЫХ запроса: тумблер упирается в тариф, бланк в
// валидацию, и слитые в один они падали бы вместе.
describe('pendingChanges письма респонденту', () => {
  it('тумблер и бланк считаются порознь', () => {
    expect(pendingChanges(saved, { ...saved, respondentOn: true })).toMatchObject({
      respondent: true,
      respondentEmail: false,
    })
    expect(pendingChanges(saved, { ...saved, respondentSource: 'blk_mail' })).toMatchObject({
      respondent: false,
      respondentEmail: true,
    })
  })

  // Спаны сравниваются ПО ЗНАЧЕНИЮ: набор символа приносит свежий массив, и по
  // ссылке страница осталась бы вечно несохранённой.
  it('одинаковый текст письма не считается правкой', () => {
    const a = { ...saved, respondentBody: textFromString('Спасибо') }
    const b = { ...saved, respondentBody: textFromString('Спасибо') }
    expect(pendingChanges(a, b).respondentEmail).toBe(false)
  })
})

// Умолчание селекта — ПЕРВЫЙ вопрос типа email в документе (решение владельца
// 2026-08-31). Считается по черновику формы, потому что автор правит письмо рядом
// с формой, которую сейчас редактирует.
describe('firstEmailQuestion', () => {
  const withBlocks = (blocks: FormDetail['draftSchema']['blocks']): FormDetail => ({
    ...newFormDetail(),
    draftSchema: { ...newFormDetail().draftSchema, blocks },
  })

  it('берёт первый email по порядку документа, а не первый вопрос', () => {
    const form = withBlocks([
      { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
      { id: 'b2', groupId: 'g2', type: 'email', settings: {} },
      { id: 'b3', groupId: 'g3', type: 'email', settings: {} },
    ])
    expect(firstEmailQuestion(form)).toBe('b2')
  })

  // Подставлять нечего — бланк скажет об этом красной строкой, а не молча
  // притворится настроенным.
  it('форма без вопроса-email даёт пустоту', () => {
    const form = withBlocks([{ id: 'b1', groupId: 'g1', type: 'short_text', settings: {} }])
    expect(firstEmailQuestion(form)).toBe('')
  })
})
