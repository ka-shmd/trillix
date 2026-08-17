import { type Uploader, type UploadedFile } from '@fields/fileUpload'

// Загрузка файла респондентом (фаза 24, docs/design/answer-files.md §3).
//
// Два шага, и первый — не формальность: сервер решает, можно ли вообще принять
// этот файл, и только потом выдаёт подпись. Байты идут в хранилище НАПРЯМУЮ,
// минуя наш API.

type SlotResponse = {
  upload_id: string
  url: string
  content_type: string
}

// XHR, а не fetch: прогресс загрузки даёт только он (у fetch нет события отправки
// тела, а ReadableStream в запросе не поддержан браузерами, которые нам нужны).
// Ради одного этого свойства он здесь и живёт — весь остальной код рендерера
// ходит через fetch.
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    // Ровно тот тип, что зашит в подпись: другой хранилище отвергнет само.
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error('хранилище не приняло файл'))
    xhr.onerror = () => reject(new Error('не удалось загрузить'))
    xhr.onabort = () => reject(new Error('загрузка отменена'))
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}

// makeUploader — загрузчик для конкретной формы. Токен тот же, что уйдёт с
// ответом: без него сервер слот не выдаст.
export function makeUploader(slug: string, token: string): Uploader {
  return async ({ blockId, file, onProgress, signal }): Promise<UploadedFile> => {
    const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        block_id: blockId,
        file_name: file.name,
        size_bytes: file.size,
        content_type: file.type,
      }),
      signal,
    })
    if (!res.ok) {
      // Сообщение сервера показывается как есть: оно объясняет причину отказа
      // («такой тип файла загрузить нельзя», «больше 10 МиБ»), а придуманный
      // здесь текст разошёлся бы с настоящей причиной.
      throw new Error(await errorMessage(res))
    }
    const slot = (await res.json()) as SlotResponse
    await putWithProgress(slot.url, file, slot.content_type, onProgress, signal)
    return { id: slot.upload_id, name: file.name, size: file.size }
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    return body.error?.message ?? 'не удалось загрузить'
  } catch {
    return 'не удалось загрузить'
  }
}
