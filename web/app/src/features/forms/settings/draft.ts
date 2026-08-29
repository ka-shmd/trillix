import { isHttpUrl } from '@entities/formSchema'
import type { FormDetail } from '../../../entities/form'

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
  closeLocal: string
  limit: string
  closedMessage: string
  notify: boolean
  partial: boolean
  // Живые колонки формы: шкала прогресса (0040) и бейдж «Сделано в Trillix» (0038).
  // На странице настроек они такой же черновик, как поля, — сохраняются кнопкой.
  progress: boolean
  branding: boolean
}

export function settingsFromForm(form: FormDetail): SettingsDraft {
  const redirectUrl = form.draftSchema.redirectUrl ?? ''
  return {
    thankYouText: form.draftSchema.thankYouText ?? '',
    redirectOn: redirectUrl !== '',
    redirectUrl,
    closeLocal: isoToLocalInput(form.closeAt),
    limit: form.responseLimit === null ? '' : String(form.responseLimit),
    closedMessage: form.closedMessage ?? '',
    notify: form.notifyOnSubmission,
    partial: form.collectPartial,
    progress: form.progress,
    branding: form.branding,
  }
}

// Что уедет в схему как redirectUrl. Выключенный тумблер — пустая строка: именно
// так «переадресации нет» и хранится, отдельного признака у схемы нет.
export function redirectValue(draft: SettingsDraft): string {
  return draft.redirectOn ? draft.redirectUrl.trim() : ''
}

export interface SettingsInvalid {
  // ПУСТОЕ ПОЛЕ И БИТЫЙ АДРЕС — РАЗНЫЕ СОСТОЯНИЯ, и путать их нельзя: включённый
  // тумблер сразу подсвечивал поле красным и требовал «начните с http://» у поля, в
  // которое человек ещё не печатал, — то есть ругался на собственное действие
  // автора. Сохранение не пропускают оба, но красным помечается только `url`.
  urlMissing: boolean
  url: boolean
  limit: boolean
}

export function validateSettings(draft: SettingsDraft): SettingsInvalid {
  const url = draft.redirectUrl.trim()
  const limit = draft.limit.trim()
  const limitNum = Number(limit)
  return {
    // Включённый тумблер требует адрес: пустое поле под ним — незаконченная
    // настройка, и сохранить её молча значило бы выключить переадресацию за автора.
    urlMissing: draft.redirectOn && url === '',
    url: draft.redirectOn && url !== '' && !isHttpUrl(url),
    limit: limit !== '' && (!Number.isInteger(limitNum) || limitNum < 1),
  }
}

// Что именно поедет на сервер. Четыре независимых адресата: поля схемы («После
// отправки»), живые колонки закрытия, тумблер писем, тумблер незавершённых —
// нетронутый раздел запроса не делает.
export interface PendingChanges {
  afterSubmit: boolean
  close: boolean
  notify: boolean
  partial: boolean
  // Живые колонки формы: шкала прогресса (0040) и бейдж «Сделано в Trillix» (0038).
  // На странице настроек они такой же черновик, как поля, — сохраняются кнопкой.
  progress: boolean
  branding: boolean
}

export function pendingChanges(saved: SettingsDraft, draft: SettingsDraft): PendingChanges {
  return {
    afterSubmit:
      draft.thankYouText !== saved.thankYouText || redirectValue(draft) !== saved.redirectUrl,
    close:
      draft.closeLocal !== saved.closeLocal ||
      draft.limit.trim() !== saved.limit ||
      draft.closedMessage !== saved.closedMessage,
    notify: draft.notify !== saved.notify,
    partial: draft.partial !== saved.partial,
    progress: draft.progress !== saved.progress,
    branding: draft.branding !== saved.branding,
  }
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
