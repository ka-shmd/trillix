import { z } from 'zod'

import { isHttpUrl, plainText, sameRichText, textFromString, type Span } from '@entities/formSchema'
import {
  MAX_NOTIFY_BODY_LEN,
  MAX_NOTIFY_SUBJECT_LEN,
  type CloseSettingsInput,
  type FormDetail,
  type NotifyEmail,
  type RespondentEmail,
} from '../../../entities/form'

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
  // Тема и текст письма — СПАНЫ (mentions.md §10): в них живёт подстановка ответа.
  // ⚠ Сравнивать их можно только ПО ЗНАЧЕНИЮ (sameRichText): набор символа приносит
  // свежий массив с тем же содержимым, и по ссылке страница осталась бы вечно
  // несохранённой, а mergeServer затирал бы правку автора чужим значением.
  notifySubject: Span[]
  notifyBody: Span[]
  notifyAttachPdf: boolean
  // Письмо респонденту (0046): тумблер, вопрос-источник адреса и тот же бланк, что
  // у письма владельцу. Поля отдельные, а не общая структура: у двух писем разные
  // умолчания и разные адресаты, и слить их значило бы править одно письмо, меняя
  // другое.
  respondentOn: boolean
  respondentSource: string
  respondentFromName: string
  respondentReplyTo: string
  respondentSubject: Span[]
  respondentBody: Span[]
  respondentAttachPdf: boolean
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
    // Имя отправителя и тема ПОДСТАВЛЯЮТСЯ УМОЛЧАНИЯМИ письма, когда автор их не
    // переписывал: в бланке стоит настоящий текст письма, а не подсказка о нём.
    // Подставляется и в черновик, и в сохранённое состояние — иначе открытая
    // страница считалась бы изменённой, ничего не изменив (см. notifyEmailValue,
    // который тем же умолчанием разворачивает значение обратно в пустое).
    notifyFromName: form.notifyEmail?.fromName || form.notifyMail.fromName,
    notifyReplyTo: form.notifyEmail?.replyTo ?? '',
    notifySubject: defaultSubject(form),
    notifyBody: form.notifyEmail?.body ?? [],
    notifyAttachPdf: form.notifyEmail?.attachPdf ?? false,
    respondentOn: form.notifyRespondent,
    respondentSource: form.respondentEmail?.sourceBlockId ?? '',
    respondentFromName: form.respondentEmail?.fromName || form.respondentMail.fromName,
    respondentReplyTo: form.respondentEmail?.replyTo ?? '',
    respondentSubject: defaultRespondentSubject(form),
    respondentBody: form.respondentEmail?.body ?? [],
    respondentAttachPdf: form.respondentEmail?.attachPdf ?? false,
    partial: form.collectPartial,
    progress: form.progress,
    branding: form.branding,
    autoJump: form.autoJump,
    saveLocally: form.saveLocally,
  }
}

// Что уедет в схему как redirectUrl. Выключенный тумблер — пустая строка: именно
// так «переадресации нет» и хранится, отдельного признака у схемы нет.
// Тема бланка: своя, если автор её писал, иначе УМОЛЧАНИЕ ПИСЬМА строкой с сервера.
// Бланк показывает настоящий текст письма, а не подсказку о нём, и брать этот текст
// фронту больше негде (mail.DefaultSubject).
function defaultSubject(form: FormDetail): Span[] {
  const own = form.notifyEmail?.subject ?? []
  return own.length > 0 ? own : textFromString(form.notifyMail.subject)
}

// Тема бланка письма респонденту — своя, а не тема письма владельцу: письма
// разные, и умолчание у каждого своё (mail.DefaultSubject по своему шаблону).
function defaultRespondentSubject(form: FormDetail): Span[] {
  const own = form.respondentEmail?.subject ?? []
  return own.length > 0 ? own : textFromString(form.respondentMail.subject)
}

// Вопрос-источник адреса ПО УМОЛЧАНИЮ: первый вопрос типа email в документе
// (решение владельца 2026-08-31). Это именно умолчание СЕЛЕКТА, а не серверный
// автоподбор: подставленное значение уезжает в колонку обычным сохранением, и
// хранимый источник всегда остаётся точным id.
//
// ⚠ Разница не косметическая. Сервер, трактующий пустой источник как «первый
// email-вопрос», менял бы получателя писем на каждой правке полотна — молча и
// задним числом; ровно поэтому автоподбор и был отвергнут (respondent-email.md §3).
// Здесь же автор видит подставленный вопрос на экране и может его сменить.
//
// Пустая строка — форма без единого вопроса-email: подставлять нечего, и бланк
// говорит об этом красной строкой.
export function firstEmailQuestion(form: FormDetail): string {
  return form.draftSchema.blocks.find((b) => b.type === 'email')?.id ?? ''
}

export function redirectValue(draft: SettingsDraft): string {
  return draft.redirectOn ? draft.redirectUrl.trim() : ''
}

// Настройка письма в виде, в котором её принимает API: обрезанные поля, кроме
// текста (в нём пробелы по краям — часть письма).
//
// Значение, равное умолчанию, уезжает ПУСТЫМ. Это не оптимизация: «не настраивал»
// хранится пустотой (колонка NULL), и записать в неё сегодняшний текст шаблона
// значило бы заморозить его — правка шаблона перестала бы доезжать до всех, кто
// когда-либо открывал эту страницу и сохранял её кнопкой.
export function notifyEmailValue(
  draft: SettingsDraft,
  mail: FormDetail['notifyMail'],
): NotifyEmail {
  const fromName = draft.notifyFromName.trim()
  return {
    fromName: fromName === mail.fromName ? '' : fromName,
    replyTo: draft.notifyReplyTo.trim(),
    subject: isDefaultSubject(draft.notifySubject, mail.subject) ? [] : draft.notifySubject,
    body: draft.notifyBody,
    attachPdf: draft.notifyAttachPdf,
  }
}

// Бланк письма респонденту в виде, в котором его принимает API. Правило про
// умолчания то же, что у notifyEmailValue: равное умолчанию уезжает пустым, иначе
// сегодняшний текст шаблона заморозился бы в колонке.
//
// sourceBlockId уезжает КАК ЕСТЬ, в том числе указывающий на удалённый вопрос:
// стереть его за автора значило бы молча решить за него, что письмо больше не нужно.
export function respondentEmailValue(
  draft: SettingsDraft,
  mail: FormDetail['respondentMail'],
): RespondentEmail {
  const fromName = draft.respondentFromName.trim()
  return {
    sourceBlockId: draft.respondentSource,
    fromName: fromName === mail.fromName ? '' : fromName,
    replyTo: draft.respondentReplyTo.trim(),
    subject: isDefaultSubject(draft.respondentSubject, mail.subject) ? [] : draft.respondentSubject,
    body: draft.respondentBody,
    attachPdf: draft.respondentAttachPdf,
  }
}

// Тема равна умолчанию — и потому уезжает пустой. Чип в теме исключает это сразу,
// даже если его имя совпало с текстом шаблона по буквам: подстановка — это правка
// автора, и стереть её как «ничего не менял» нельзя.
function isDefaultSubject(subject: Span[], fallback: string): boolean {
  return !subject.some((s) => s.ref) && plainText(subject).trim() === fallback
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
  // Потолки темы и текста письма. У contenteditable нет maxLength, поэтому длину
  // держит сохранение: молча уехавший на сервер перебор вернулся бы 422 с общей
  // фразой «ошибка сохранения», не назвав ни поля, ни причины.
  notifySubjectLong: boolean
  notifyBodyLong: boolean
  // Те же три проверки для бланка письма респонденту.
  respondentReplyTo: boolean
  respondentSubjectLong: boolean
  respondentBodyLong: boolean
  // Включённое закрытие по дате без даты — незаконченная настройка, как включённая
  // переадресация без адреса.
  closeAt: boolean
}

export function validateSettings(draft: SettingsDraft): SettingsInvalid {
  const url = draft.redirectUrl.trim()
  const replyTo = draft.notifyReplyTo.trim()
  const respondentReplyTo = draft.respondentReplyTo.trim()
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
    notifySubjectLong: plainText(draft.notifySubject).length > MAX_NOTIFY_SUBJECT_LEN,
    notifyBodyLong: plainText(draft.notifyBody).length > MAX_NOTIFY_BODY_LEN,
    respondentReplyTo: respondentReplyTo !== '' && !emailCheck.safeParse(respondentReplyTo).success,
    respondentSubjectLong: plainText(draft.respondentSubject).length > MAX_NOTIFY_SUBJECT_LEN,
    respondentBodyLong: plainText(draft.respondentBody).length > MAX_NOTIFY_BODY_LEN,
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
  // Тумблер и бланк письма респонденту — два разных запроса, как у письма
  // владельцу: тумблер может упереться в тариф, бланк — в валидацию.
  respondent: boolean
  respondentEmail: boolean
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
      !sameRichText(draft.notifySubject, saved.notifySubject) ||
      !sameRichText(draft.notifyBody, saved.notifyBody) ||
      draft.notifyAttachPdf !== saved.notifyAttachPdf,
    respondent: draft.respondentOn !== saved.respondentOn,
    respondentEmail:
      draft.respondentSource !== saved.respondentSource ||
      draft.respondentFromName.trim() !== saved.respondentFromName ||
      draft.respondentReplyTo.trim() !== saved.respondentReplyTo ||
      !sameRichText(draft.respondentSubject, saved.respondentSubject) ||
      !sameRichText(draft.respondentBody, saved.respondentBody) ||
      draft.respondentAttachPdf !== saved.respondentAttachPdf,
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
    if (!sameField(key, prev, next)) Object.assign(merged, { [key]: next[key] })
  }
  return merged
}

// Равенство ОДНОГО поля черновика. Существует ради двух полей-спанов: остальные —
// строки, числа и флаги, и им хватает ===. Прямое сравнение массивов дало бы «поле
// изменилось» на каждом рендере — тот же класс мины, что sameRichText чинит в сторе
// полотна.
function sameField(key: keyof SettingsDraft, a: SettingsDraft, b: SettingsDraft): boolean {
  if (
    key === 'notifySubject' ||
    key === 'notifyBody' ||
    key === 'respondentSubject' ||
    key === 'respondentBody'
  ) {
    return sameRichText(a[key], b[key])
  }
  return a[key] === b[key]
}

export function sameSettings(a: SettingsDraft, b: SettingsDraft): boolean {
  return (Object.keys(a) as (keyof SettingsDraft)[]).every((key) => sameField(key, a, b))
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
