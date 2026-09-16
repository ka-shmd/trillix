// Загрузка картинки блока с прогрессом. XHR, а не fetch: нужен upload.onprogress
// для прогресс-бара (fetch прогресс отправки тела надёжно не даёт — docs/
// docs/design/s3-media.md §6a). Синхронный HTTP-путь: ответ 201 и есть завершение,
// статус-поллинга нет.

import { z } from 'zod'

import { apiRequest } from '../../../shared/api/client'
import { CSRF_HEADER, csrfToken } from '../../../shared/api/csrf'

import logoPlaceholderUrl from '@/assets/logo-placeholder.png'

export interface UploadHandlers {
  onProgress?: (pct: number) => void
}

// Назначение картинки: где она будет показана. Влияет только на потолок ширины при
// нормализации на сервере (media.Purpose, internal/media/service.go) — обложка шире
// колонки, логотип кратно уже. Значение по умолчанию — картинка блока.
//
// preview и icon — карточка ссылки: их показывает не наша страница, а мессенджер,
// поэтому потолки там взяты из канона площадок (1200 и 256), а не из вида формы.
export type UploadPurpose = 'block' | 'cover' | 'logo' | 'preview' | 'icon'

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

// uploadLogoPlaceholder заводит логотип-заглушку: картинка из сборки кабинета грузится
// в хранилище формы тем же путём, что файл автора, — схема знает только imageKey, и
// общего ключа «логотип по умолчанию» у неё нет.
export function uploadLogoPlaceholder(form: FormIdSource): Promise<string> {
  return fetch(logoPlaceholderUrl)
    .then((res) => {
      if (!res.ok) throw new Error('Не удалось добавить логотип')
      return res.blob()
    })
    .then((blob) =>
      uploadImage(form, new File([blob], 'logo.png', { type: 'image/png' }), {}, 'logo'),
    )
}

const uploadResponseSchema = z.object({ imageKey: z.string().min(1) })

// importImage — картинка по ссылке автора: байты скачивает сервер (через safehttp) и
// кладёт в хранилище тем же путём, что файл, отвечая тем же imageKey. Чужой адрес в
// схему не пишется — CSP формы пускает картинки только со своего origin.
// Тот же адрес, что у файла, но тело — JSON; отказ сервера несёт человеческую причину.
export function importImage(
  form: FormIdSource,
  url: string,
  purpose: UploadPurpose = 'block',
): Promise<string> {
  return resolveFormId(form)
    .then((formId) =>
      apiRequest(`/forms/${formId}/media`, {
        method: 'POST',
        body: { url, purpose },
        schema: uploadResponseSchema,
      }),
    )
    .then((r) => r.imageKey)
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
