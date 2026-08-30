import { createContext, useContext } from 'react'

// Как поле-файл получает загрузчик (фаза 24, docs/design/answer-files.md).
//
// Контрол поля живёт в @fields и общий для трёх поверхностей, а загрузка требует того,
// чего у контрола нет и быть не должно: адреса формы, токена и знания о presigned-потоке.
// Поэтому загрузчик приходит контекстом: рендерер кладёт в него настоящий, превью
// билдера — ничего.
//
// Отсутствие загрузчика — не ошибка, а состояние: на полотне и в превью поле рисуется
// целиком, но файлов не принимает (там оно и так disabled). Контрол, который в этом
// случае звал бы несуществующую функцию, падал бы ровно у автора формы.

// UploadedFile — то, что известно о файле ПОСЛЕ загрузки. id — он же право на файл:
// случайный идентификатор, выданный сервером, и единственное, что уезжает в ответ.
export type UploadedFile = { id: string; name: string; size: number }

// Uploader — загрузка одного файла. onProgress зовётся долей [0, 1]; signal отменяет
// загрузку, когда респондент убрал файл, не дождавшись конца.
export type Uploader = (args: {
  blockId: string
  file: File
  onProgress: (fraction: number) => void
  signal: AbortSignal
}) => Promise<UploadedFile>

// KnownFiles — имена и размеры файлов, приложенных к УЖЕ отправленному ответу
// (id → файл). Нужны там, где форма показывается заполненной, а загрузки не было:
// печатная страница ответа рисует список файлов по одним id из ответа, и без этой
// карты у неё нет ничего, кроме слова «файл».
//
// Отдельный контекст, а не поле загрузчика: у печати загрузчика нет вовсе, а у
// рендерера нет этой карты — совмещать их значило бы заставлять каждую поверхность
// объявлять ненужную ей половину.
const KnownFilesContext = createContext<Record<string, UploadedFile> | null>(null)

export const KnownFilesProvider = KnownFilesContext.Provider

export const useKnownFiles = (): Record<string, UploadedFile> | null =>
  useContext(KnownFilesContext)

const UploaderContext = createContext<Uploader | null>(null)

export const UploaderProvider = UploaderContext.Provider

export const useUploader = (): Uploader | null => useContext(UploaderContext)

// Человеческий размер файла. Единицы двоичные — те же, в которых автор задаёт потолок
// («до 10 МиБ»), иначе файл 10,4 МБ выглядел бы прошедшим лимит, который он превысил.
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  const kib = bytes / 1024
  if (kib < 1024) return `${Math.round(kib)} КиБ`
  const mib = kib / 1024
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} МиБ`
}
