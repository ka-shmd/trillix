import { z } from 'zod'

import { isHttpUrl } from '@entities/formSchema'
import type { CloseSettingsInput, FormDetail, NotifyEmail } from '../../../entities/form'

// Черновик страницы настроек: ВСЯ страница разом, а не раздел за разделом.
//
// Настройки сохраняются одной кнопкой в подвале (решение владельца 2026-08-29,
// отменяет прежние «Сохранить» в каждом разделе), поэтому у страницы один
// черновик, одно состояние «есть несохранённое» и один момент отправки. Куда
// поедет каждое поле — дело `pendingChanges`: за одной кнопкой стоят четыре
// разных запроса, и лишние из них не отправляются.
export interface SettingsDraft {
  thankYouText: string
  // Переадресация — ТУМБЛЕР ПЛЮС АДРЕС, а не один только адрес (решение владельца
  // 2026-08-29). Пустая ссылка при включённом тумблере — не «переадресации нет», а
  // недозаполненная настройка: сохранение её не пропускает. Выключенный тумблер
  // уезжает на сервер пустой строкой, набранный адрес при этом остаётся в черновике
  // до сохранения — передумавший автор не перепечатывает его заново.
  redirectOn: boolean
  redirectUrl: string
  // Дата закрытия — в виде <input type="datetime-local">, то есть в ЛОКАЛЬНОМ
  // времени; на сервер уезжает ISO в UTC (localInputToIso).
  // Закрытие формы разложено на ТУМБЛЕР ПЛЮС ЗНАЧЕНИЕ, как переадресация: у каждой
  // строки блока «Доступность» свой выключатель, а поля под ним появляются
  // включёнными. Выключенный тумблер уезжает на сервер снятым ограничением
  // (null/пусто), но набранное остаётся в черновике до сохранения.
  closedNow: boolean
  closeOn: boolean
  closeLocal: string
  limitOn: boolean
  limit: string
  closedMessageOn: boolean
  closedTitle: string
  closedMessage: string
  notify: boolean
  // Письмо о новом ответе: что автор в нём переписал. Пустые значения = «слать
  // дефолтным шаблоном», и на сервер они уезжают именно пустыми — там настройка
  // нормализуется в NULL.
  notifyFromName: string
  notifyReplyTo: string
  notifySubject: string
  notifyBody: string
  notifyAttachPdf: boolean
  partial: boolean
  // Живые колонки формы: шкала прогресса (0040) и бейдж «Сделано в Trillix» (0038).
  // На странице настроек они такой же черновик, как поля, — сохраняются кнопкой.
  progress: boolean
  branding: boolean
  // Раздел «Поведение» (0044).
  autoJump: boolean
  saveLocally: boolean
}

export function settingsFromForm(form: FormDetail): SettingsDraft {
  const redirectUrl = form.draftSchema.redirectUrl ?? ''
  return {
    thankYouText: form.draftSchema.thankYouText ?? '',
    redirectOn: redirectUrl !== '',
    redirectUrl,
    closedNow: form.status === 'closed',
    closeOn: form.closeAt !== null,
    closeLocal: isoToLocalInput(form.closeAt),
    limitOn: form.responseLimit !== null,
    limit: form.responseLimit === null ? '' : String(form.responseLimit),
    closedMessageOn: (form.closedTitle ?? '') !== '' || (form.closedMessage ?? '') !== '',
    closedTitle: form.closedTitle ?? '',
    closedMessage: form.closedMessage ?? '',
    notify: form.notifyOnSubmission,
    notifyFromName: form.notifyEmail?.fromName ?? '',
    notifyReplyTo: form.notifyEmail?.replyTo ?? '',
    notifySubject: form.notifyEmail?.subject ?? '',
    notifyBody: form.notifyEmail?.body ?? '',
    notifyAttachPdf: form.notifyEmail?.attachPdf ?? false,
    partial: form.collectPartial,
    progress: form.progress,
    branding: form.branding,
    autoJump: form.autoJump,
    saveLocally: form.saveLocally,
  }
}

// Что уедет в схему как redirectUrl. Выключенный тумблер — пустая строка: именно
// так «переадресации нет» и хранится, отдельного признака у схемы нет.
export function redirectValue(draft: SettingsDraft): string {
  return draft.redirectOn ? draft.redirectUrl.trim() : ''
}

// Настройка письма в виде, в котором её принимает API: обрезанные поля, кроме
// текста (в нём пробелы по краям — часть письма).
export function notifyEmailValue(draft: SettingsDraft): NotifyEmail {
  return {
    fromName: draft.notifyFromName.trim(),
    replyTo: draft.notifyReplyTo.trim(),
    subject: draft.notifySubject.trim(),
    body: draft.notifyBody,
    attachPdf: draft.notifyAttachPdf,
  }
}

// Тот же строгий разбор адреса, каким рендерер проверяет ответ на вопрос-email:
// адрес есть адрес, и две разные строгости означали бы, что где-то принимается то,
// что рядом отвергается.
const emailCheck = z.email()

// Настройки закрытия в виде, в котором их принимает API: выключенный тумблер = снятое
// ограничение (null/пусто), а не «сохранить набранное на будущее».
export function closeSettingsValue(draft: SettingsDraft): CloseSettingsInput {
  const limit = draft.limit.trim()
  return {
    closeAt: draft.closeOn ? localInputToIso(draft.closeLocal) : null,
    responseLimit: draft.limitOn && limit !== '' ? Number(limit) : null,
    closedTitle: draft.closedMessageOn ? draft.closedTitle.trim() : '',
    closedMessage: draft.closedMessageOn ? draft.closedMessage : '',
  }
}

export interface SettingsInvalid {
  // ПУСТОЕ ПОЛЕ И БИТЫЙ АДРЕС — РАЗНЫЕ СОСТОЯНИЯ, и путать их нельзя: включённый
  // тумблер сразу подсвечивал поле красным и требовал «начните с http://» у поля, в
  // которое человек ещё не печатал, — то есть ругался на собственное действие
  // автора. Сохранение не пропускают оба, но красным помечается только `url`.
  urlMissing: boolean
  url: boolean
  limit: boolean
  // Reply-To проверяется строго: битый адрес — это письмо, которое отвергнет
  // почтовый провайдер, то есть молча пропавшее уведомление.
  replyTo: boolean
  // Включённое закрытие по дате без даты — незаконченная настройка, как включённая
  // переадресация без адреса.
  closeAt: boolean
}

export function validateSettings(draft: SettingsDraft): SettingsInvalid {
  const url = draft.redirectUrl.trim()
  const replyTo = draft.notifyReplyTo.trim()
  const limit = draft.limit.trim()
  const limitNum = Number(limit)
  const limitOn = draft.limitOn
  return {
    // Включённый тумблер требует адрес: пустое поле под ним — незаконченная
    // настройка, и сохранить её молча значило бы выключить переадресацию за автора.
    urlMissing: draft.redirectOn && url === '',
    url: draft.redirectOn && url !== '' && !isHttpUrl(url),
    limit: limitOn && (limit === '' || !Number.isInteger(limitNum) || limitNum < 1),
    closeAt: draft.closeOn && localInputToIso(draft.closeLocal) === null,
    replyTo: replyTo !== '' && !emailCheck.safeParse(replyTo).success,
  }
}

// Что именно поедет на сервер. Четыре независимых адресата: поля схемы («После
// отправки»), живые колонки закрытия, тумблер писем, тумблер незавершённых —
// нетронутый раздел запроса не делает.
export interface PendingChanges {
  afterSubmit: boolean
  close: boolean
  // Статус формы: закрыта или принимает ответы. Не колонка настроек, а отдельные
  // ручки (unpublish/reopen), поэтому и грань своя.
  closedNow: boolean
  notify: boolean
  notifyEmail: boolean
  partial: boolean
  // Живые колонки формы: шкала прогресса (0040) и бейдж «Сделано в Trillix» (0038).
  // На странице настроек они такой же черновик, как поля, — сохраняются кнопкой.
  progress: boolean
  branding: boolean
  behavior: boolean
}

export function pendingChanges(saved: SettingsDraft, draft: SettingsDraft): PendingChanges {
  return {
    afterSubmit:
      draft.thankYouText !== saved.thankYouText || redirectValue(draft) !== saved.redirectUrl,
    close: !sameCloseSettings(closeSettingsValue(saved), closeSettingsValue(draft)),
    closedNow: draft.closedNow !== saved.closedNow,
    notify: draft.notify !== saved.notify,
    notifyEmail:
      draft.notifyFromName.trim() !== saved.notifyFromName ||
      draft.notifyReplyTo.trim() !== saved.notifyReplyTo ||
      draft.notifySubject.trim() !== saved.notifySubject ||
      draft.notifyBody !== saved.notifyBody ||
      draft.notifyAttachPdf !== saved.notifyAttachPdf,
    partial: draft.partial !== saved.partial,
    progress: draft.progress !== saved.progress,
    branding: draft.branding !== saved.branding,
    behavior: draft.autoJump !== saved.autoJump || draft.saveLocally !== saved.saveLocally,
  }
}

// Сравнение настроек закрытия по ЗНАЧЕНИЮ, а не по полям черновика: выключенный
// тумблер и пустое поле под ним дают один и тот же запрос, и считать это правкой
// значит держать страницу вечно «несохранённой».
function sameCloseSettings(a: CloseSettingsInput, b: CloseSettingsInput): boolean {
  return (
    a.closeAt === b.closeAt &&
    a.responseLimit === b.responseLimit &&
    a.closedTitle === b.closedTitle &&
    a.closedMessage === b.closedMessage
  )
}

export function isDirty(saved: SettingsDraft, draft: SettingsDraft): boolean {
  return Object.values(pendingChanges(saved, draft)).some(Boolean)
}

// Догон серверного значения ПО ОДНОМУ ПОЛЮ. Деталь формы меняют мимо этой страницы
// (редактор, соседняя вкладка), и черновик обязан подхватить чужую правку — но
// только тех полей, которые действительно изменились на сервере.
//
// Мина: сравнивать целиком нельзя. Одна кнопка шлёт до четырёх запросов, и часть
// из них может провалиться (конфликт версий, отказ тарифа); успешный запрос
// меняет деталь формы, и черновик целиком сбросился бы на серверный — вместе с
// правками, которые как раз НЕ сохранились. Человек потерял бы ровно то, что ему
// сейчас надо повторить.
export function mergeServer(
  draft: SettingsDraft,
  prev: SettingsDraft,
  next: SettingsDraft,
): SettingsDraft {
  const merged: SettingsDraft = { ...draft }
  for (const key of Object.keys(next) as (keyof SettingsDraft)[]) {
    if (prev[key] !== next[key]) Object.assign(merged, { [key]: next[key] })
  }
  return merged
}

export function sameSettings(a: SettingsDraft, b: SettingsDraft): boolean {
  return (Object.keys(a) as (keyof SettingsDraft)[]).every((key) => a[key] === b[key])
}

// isoToLocalInput — ISO-строка (UTC с сервера) → значение <input type="datetime-local">
// (локальное время, поминутная точность). Пусто/битое → пустая строка.
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// localInputToIso — обратно: локальное значение поля → ISO в UTC. Пусто → null
// (настройка снята).
export function localInputToIso(local: string): string | null {
  if (local.trim() === '') return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
