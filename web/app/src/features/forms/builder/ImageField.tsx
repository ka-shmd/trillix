import { useRef, useState, type ChangeEvent } from 'react'
import { ImagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { type Block, MAX_ALT_LEN } from '@entities/formSchema'
import { mediaSrc } from '@fields/media'
import { useBuilderStore } from './storeContext'
import { uploadImage } from './mediaUpload'

// ImageField — редактор image-блока: пустой блок показывает зону загрузки, при
// выборе файла — оптимистичный локальный превью (createObjectURL) с прогресс-баром,
// на успех пишет settings.imageKey (автосейв сохранит), готовый блок — картинка +
// поле alt + «заменить»/«удалить». Вид самой картинки — общий rf-image; layout и
// зона загрузки — Tailwind (editor-only, респондент их не видит).
export function ImageField({ block, formId }: { block: Block; formId: string }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const imageKey = block.settings?.imageKey
  const alt = block.settings?.alt ?? ''
  const fileRef = useRef<HTMLInputElement>(null)
  // Локальный превью на время загрузки (blob:-URL); прогресс 0–100 или null (не грузим).
  const [preview, setPreview] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = () => fileRef.current?.click()

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // позволить повторно выбрать тот же файл
    if (!file) return
    setError(null)
    const localURL = URL.createObjectURL(file)
    setPreview(localURL)
    setProgress(0)
    uploadImage(formId, file, { onProgress: setProgress })
      .then((key) => updateBlock(block.id, { settings: { ...block.settings, imageKey: key } }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => {
        URL.revokeObjectURL(localURL)
        setPreview(null)
        setProgress(null)
      })
  }

  const uploading = progress !== null
  const shownSrc = preview ?? (imageKey ? mediaSrc(imageKey) : null)

  return (
    <div className="mt-1.5">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />

      {shownSrc ? (
        <div className="relative w-fit">
          <img className="rf-image" src={shownSrc} alt={alt} />
          {uploading && <ProgressOverlay pct={progress} />}
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          className="flex min-h-32 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--rf-radius)] border border-dashed border-muted-foreground/40 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <ImagePlus className="size-4" /> Загрузить картинку (PNG или JPEG)
        </button>
      )}

      {error && (
        <p className="mt-1.5 text-sm text-destructive">
          {error} ·{' '}
          <button type="button" onClick={pick} className="underline hover:no-underline">
            Повторить
          </button>
        </p>
      )}

      {imageKey && !uploading && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex gap-3 text-sm text-muted-foreground">
            <button type="button" onClick={pick} className="flex items-center gap-1 hover:text-foreground">
              <RefreshCw className="size-3.5" /> Заменить
            </button>
            <button
              type="button"
              onClick={() => updateBlock(block.id, { settings: {} })}
              className="flex items-center gap-1 hover:text-destructive"
            >
              <Trash2 className="size-3.5" /> Удалить
            </button>
          </div>
          <input
            value={alt}
            onChange={(e) => updateBlock(block.id, { settings: { ...block.settings, alt: e.target.value } })}
            maxLength={MAX_ALT_LEN}
            placeholder="Описание картинки (alt, необязательно)"
            aria-label="Описание картинки (alt)"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      )}
    </div>
  )
}

// ProgressOverlay — полупрозрачная плашка с прогресс-баром поверх локального превью.
function ProgressOverlay({ pct }: { pct: number }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-[var(--rf-radius)] bg-background/60">
      <div className="w-2/3 max-w-40">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-center text-xs text-muted-foreground">Загрузка… {pct}%</p>
      </div>
    </div>
  )
}
