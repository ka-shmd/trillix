import type { SpreadsheetRef } from '../../entities/integration'

// Окно выбора файла на Google Диске (Google Picker).
//
// Зачем оно вообще: под scope drive.file приложение видит только те файлы,
// которые создало само, — «вставьте ссылку на свою таблицу» упёрлось бы в 404 у
// сервера. Picker — единственный способ дать человеку выбрать СВОЙ файл, не
// прося доступ ко всему Диску: выбранный им файл Google выдаёт нашему
// приложению по тому же drive.file, и дальше сервер работает с ним обычным
// путём.
//
// Цена, названная в ADR §10: в кабинете исполняется скрипт с apis.google.com, а
// в браузер уезжает живой access-токен Google (час, scope drive.file). Token
// приходит по нажатию кнопки и в стейте страницы не задерживается.

export interface PickerCredentials {
  accessToken: string
  developerKey: string
  appId: string
}

const SCRIPT_SRC = 'https://apis.google.com/js/api.js'

// Минимальные типы вместо @types/gapi: список зависимостей заморожен, а нужны
// здесь три вызова. Всё, что не описано, в этот файл и не приходит.
interface PickerBuilderLike {
  addView(view: unknown): PickerBuilderLike
  setOAuthToken(token: string): PickerBuilderLike
  setDeveloperKey(key: string): PickerBuilderLike
  setAppId(appId: string): PickerBuilderLike
  setCallback(cb: (data: PickerData) => void): PickerBuilderLike
  build(): { setVisible(visible: boolean): void }
}

interface PickerData {
  action: string
  docs?: { id: string; name: string }[]
}

interface GoogleApi {
  gapi?: { load(name: string, cb: () => void): void }
  google?: {
    picker: {
      PickerBuilder: new () => PickerBuilderLike
      DocsView: new (viewId: unknown) => { setMode?(mode: unknown): unknown }
      ViewId: { SPREADSHEETS: unknown }
      Action: { PICKED: string; CANCEL: string }
      Response: { ACTION: string; DOCUMENTS: string }
    }
  }
}

let scriptLoading: Promise<void> | null = null

// loadScript тянет api.js один раз на вкладку: второй <script> Google игнорирует,
// но и лишний запрос ни к чему.
function loadScript(): Promise<void> {
  if (scriptLoading) return scriptLoading
  scriptLoading = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = SCRIPT_SRC
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => {
      // Не загрузилось — вкладка не должна залипнуть на «сейчас откроем»:
      // сбрасываем обещание, чтобы следующая попытка началась заново.
      scriptLoading = null
      reject(new Error('не удалось загрузить Google Picker'))
    }
    document.head.appendChild(el)
  })
  return scriptLoading
}

/**
 * pickSpreadsheet открывает окно выбора и отдаёт выбранную таблицу.
 * null — человек закрыл окно, ничего не выбрав: это не ошибка.
 */
export async function pickSpreadsheet(cred: PickerCredentials): Promise<SpreadsheetRef | null> {
  await loadScript()
  const api = window as unknown as GoogleApi
  if (!api.gapi) throw new Error('Google Picker недоступен')

  await new Promise<void>((resolve) => api.gapi!.load('picker', resolve))
  const picker = api.google?.picker
  if (!picker) throw new Error('Google Picker недоступен')

  return new Promise<SpreadsheetRef | null>((resolve) => {
    new picker.PickerBuilder()
      // Только таблицы: чужие документы и картинки нам всё равно нечем принять.
      .addView(new picker.DocsView(picker.ViewId.SPREADSHEETS))
      .setOAuthToken(cred.accessToken)
      .setDeveloperKey(cred.developerKey)
      // Номер проекта обязателен при drive.file: без него Google не выдаст
      // выбранный файл ИМЕННО НАШЕМУ приложению, и сервер получит 404.
      .setAppId(cred.appId)
      .setCallback((data: PickerData) => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs?.[0]
          resolve(doc ? { id: doc.id, name: doc.name } : null)
          return
        }
        if (data.action === picker.Action.CANCEL) resolve(null)
      })
      .build()
      .setVisible(true)
  })
}
