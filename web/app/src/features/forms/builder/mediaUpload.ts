// Загрузка картинки блока с прогрессом. XHR, а не fetch: нужен upload.onprogress
// для прогресс-бара (fetch прогресс отправки тела надёжно не даёт — docs/
// docs/design/s3-media.md §6a). Синхронный HTTP-путь: ответ 201 и есть завершение,
// статус-поллинга нет.

import { CSRF_HEADER, csrfToken } from '../../../shared/api/csrf'

export interface UploadHandlers {
  onProgress?: (pct: number) => void
}

// Назначение картинки: где она будет показана. Влияет только на потолок ширины при
// нормализации на сервере (media.Purpose, internal/media/service.go) — обложка шире
// колонки, логотип кратно уже. Значение по умолчанию — картинка блока.
export type UploadPurpose = 'block' | 'cover' | 'logo'

// Куда грузить: id формы — либо обещание его получить. Второе появилось с ленивым
// созданием (features/forms/draft.ts): у нового черновика формы на сервере ещё нет, а
// обложку автор вправе выбрать первым же действием — тогда id приезжает из ensureForm,
// которая по дороге форму и заводит. Полотно поэтому носит вниз не строку, а «адрес
// формы, каким он к этому моменту будет».
export type FormIdSource = string | (() => Promise<string>)

const resolveFormId = (source: FormIdSource): Promise<string> =>
  typeof source === 'string' ? Promise.resolve(source) : source()

// uploadImage грузит файл в POST /forms/{formId}/media и резолвит imageKey. Ошибки
// маппятся в человекочитаемое сообщение по статусу (сервер валидирует независимо).
export function uploadImage(
  form: FormIdSource,
  file: File,
  h: UploadHandlers = {},
  purpose: UploadPurpose = 'block',
): Promise<string> {
  return resolveFormId(form).then((formId) => sendImage(formId, file, h, purpose))
}

function sendImage(
  formId: string,
  file: File,
  h: UploadHandlers,
  purpose: UploadPurpose,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new FormData()
    body.append('file', file)
    body.append('purpose', purpose)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/v1/forms/${formId}/media`)
    xhr.withCredentials = true
    const csrf = csrfToken()
    if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) h.onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          const key = (JSON.parse(xhr.responseText) as { imageKey?: unknown }).imageKey
          if (typeof key === 'string' && key) resolve(key)
          else reject(new Error('Пустой ответ загрузки'))
        } catch {
          reject(new Error('Не удалось разобрать ответ'))
        }
      } else {
        reject(new Error(messageForStatus(xhr.status)))
      }
    }
    xhr.onerror = () => reject(new Error('Сеть недоступна'))
    xhr.send(body)
  })
}

function messageForStatus(status: number): string {
  switch (status) {
    case 413:
      return 'Файл больше 5 МБ'
    case 422:
      return 'Только PNG или JPEG'
    case 404:
      return 'Форма недоступна'
    default:
      return 'Не удалось загрузить картинку'
  }
}
