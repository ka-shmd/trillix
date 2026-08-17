import { useRef, useState } from 'react'

import { DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_SIZE_MIB } from '@entities/formSchema'

import { formatFileSize, useUploader, type UploadedFile } from '../fileUpload'
import { type Control, type ControlProps, invalidAttrs } from './contract'

// Файл в ответе. Значение поля — массив id загрузок; всё остальное, что видит
// респондент (имя, размер, прогресс), — местное состояние: ответ несёт только то, что
// проверено сервером (docs/design/answer-files.md §4.2).
//
// Один из двух узаконенных нативных контролов (web/CLAUDE.md): системный файловый диалог
// объективно лучше своего, и на телефоне он же даёт камеру и «Файлы».

// Зона перетаскивания — это label с input внутри: клик и клавиатура работают сами,
// без своего onKeyDown и без role="button".
type Pending = { key: string; name: string; size: number; progress: number; error?: string }

export const fileControl: Control = (p) => <FileField {...p} />

function FileField(p: ControlProps) {
  const upload = useUploader()
  const [pending, setPending] = useState<Pending[]>([])
  const [done, setDone] = useState<UploadedFile[]>([])
  const [over, setOver] = useState(false)
  const aborts = useRef(new Map<string, AbortController>())

  const ids = Array.isArray(p.value) ? p.value : []
  const maxFiles = p.block.settings?.maxFiles ?? DEFAULT_MAX_FILES
  const maxSizeMiB = p.block.settings?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_MIB
  const full = ids.length + pending.length >= maxFiles

  // Имя и размер держатся рядом с id: показать их — местное дело, а ответ остаётся
  // массивом id. Список done переживает те же перерисовки, что и value.
  const known = (id: string) => done.find((f) => f.id === id)

  function accept(files: FileList | null) {
    if (!files || !upload || p.disabled) return
    const room = maxFiles - ids.length - pending.length
    for (const file of Array.from(files).slice(0, Math.max(room, 0))) {
      void send(file, upload)
    }
  }

  async function send(file: File, uploader: NonNullable<typeof upload>) {
    const key = `${file.name}:${file.size}:${Date.now()}:${Math.random()}`
    const entry: Pending = { key, name: file.name, size: file.size, progress: 0 }
    if (file.size > maxSizeMiB * 1024 * 1024) {
      // Отбиваем ДО обращения к серверу: подпись на такой файл всё равно не выдадут,
      // а респондент узнает причину сразу и без ожидания.
      setPending((cur) => [...cur, { ...entry, error: `больше ${maxSizeMiB} МиБ` }])
      return
    }
    const ctl = new AbortController()
    aborts.current.set(key, ctl)
    setPending((cur) => [...cur, entry])
    try {
      const uploaded = await uploader({
        blockId: p.block.id,
        file,
        onProgress: (fraction) =>
          setPending((cur) => cur.map((x) => (x.key === key ? { ...x, progress: fraction } : x))),
        signal: ctl.signal,
      })
      setDone((cur) => [...cur, uploaded])
      p.onChange?.([...ids, uploaded.id])
      setPending((cur) => cur.filter((x) => x.key !== key))
    } catch (err) {
      if (ctl.signal.aborted) {
        setPending((cur) => cur.filter((x) => x.key !== key))
        return
      }
      const message = err instanceof Error ? err.message : 'не удалось загрузить'
      setPending((cur) => cur.map((x) => (x.key === key ? { ...x, error: message } : x)))
    } finally {
      aborts.current.delete(key)
    }
  }

  function removeUploaded(id: string) {
    p.onChange?.(ids.filter((x) => x !== id))
    setDone((cur) => cur.filter((f) => f.id !== id))
  }

  function removePending(key: string) {
    aborts.current.get(key)?.abort()
    aborts.current.delete(key)
    setPending((cur) => cur.filter((x) => x.key !== key))
  }

  return (
    <div className="rf-file">
      <label
        className={`rf-file-zone${over ? ' rf-file-zone--over' : ''}${full ? ' rf-file-zone--full' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          accept(e.dataTransfer?.files ?? null)
        }}
      >
        <input
          type="file"
          className="rf-file-input"
          multiple={maxFiles > 1}
          disabled={p.disabled || full}
          aria-label={p.label}
          {...invalidAttrs(p)}
          onChange={(e) => {
            accept(e.currentTarget.files)
            // Один и тот же файл, выбранный дважды подряд, иначе не даёт события
            // change: значение инпута не изменилось.
            e.currentTarget.value = ''
          }}
        />
        <span className="rf-file-cta">Выберите файл или перетащите сюда</span>
        <span className="rf-file-hint">
          {maxFiles > 1 ? `до ${maxFiles} файлов, ` : ''}
          до {maxSizeMiB} МиБ
        </span>
      </label>

      {(ids.length > 0 || pending.length > 0) && (
        <ul className="rf-file-list">
          {ids.map((id) => (
            <li key={id} className="rf-file-item">
              <span className="rf-file-name">{known(id)?.name ?? 'файл'}</span>
              <span className="rf-file-size">{formatFileSize(known(id)?.size ?? 0)}</span>
              <button
                type="button"
                className="rf-file-remove"
                disabled={p.disabled}
                aria-label={`Убрать файл ${known(id)?.name ?? ''}`}
                onClick={() => removeUploaded(id)}
              >
                ×
              </button>
            </li>
          ))}
          {pending.map((x) => (
            <li key={x.key} className={`rf-file-item${x.error ? ' rf-file-item--error' : ''}`}>
              <span className="rf-file-name">{x.name}</span>
              <span className="rf-file-size">{x.error ?? formatFileSize(x.size)}</span>
              {!x.error && (
                <span className="rf-file-progress" aria-hidden="true">
                  <span className="rf-file-bar" style={{ width: `${Math.round(x.progress * 100)}%` }} />
                </span>
              )}
              <button
                type="button"
                className="rf-file-remove"
                aria-label={`Отменить загрузку ${x.name}`}
                onClick={() => removePending(x.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
