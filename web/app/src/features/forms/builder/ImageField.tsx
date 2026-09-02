import { useRef, useState, type ChangeEvent } from 'react'
import { ImagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { type Block } from '@entities/formSchema'
import { mediaSrc } from '@fields/media'
import { useBuilderStore } from './storeContext'
import { uploadImage, type FormIdSource } from './mediaUpload'
import { humanError } from '../../../shared/api/errors'

// ImageField — редактор image-блока: пустой блок показывает зону загрузки, при
// выборе файла — оптимистичный локальный превью (createObjectURL) с прогресс-баром,
// на успех пишет settings.imageKey (автосейв сохранит), готовый блок — картинка;
// «заменить»/«удалить» — оверлей поверх картинки, виден при наведении.
// Вид самой картинки — общий rf-image; layout и
// зона загрузки — Tailwind (editor-only, респондент их не видит).
export function ImageField({ block, formId }: { block: Block; formId: FormIdSource }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const imageKey = block.settings?.imageKey
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
      .catch((err: unknown) => setError(humanError(err, 'Ошибка загрузки')))
      .finally(() => {
        URL.revokeObjectURL(localURL)
        setPreview(null)
        setProgress(null)
      })
  }

  const uploading = progress !== null
  const shownSrc = preview ?? (imageKey ? mediaSrc(imageKey) : null)

  return (
    // Свой вертикальный отступ не нужен: просвет до соседей задаёт ритм полотна
    // (картинка — блок-одиночка, 12px через .rf-group/список; этап 13.3). Прежний
    // mt-1.5 смещал зону загрузки на 6px и рвал замер редактор/превью.
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />

      {shownSrc ? (
        <div className="group relative w-fit">
          <img className="rf-image" src={shownSrc} alt="" />
          {uploading && <ProgressOverlay pct={progress} />}
          {imageKey && !uploading && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-[var(--rf-radius)] bg-black/35 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                onClick={pick}
                className="flex items-center gap-1.5 rounded-[var(--rf-radius)] bg-[var(--rf-field-bg)] px-3 py-1.5 text-sm font-medium text-[var(--rf-text)] transition-colors hover:bg-[color-mix(in_oklab,var(--rf-field-bg)_92%,var(--rf-text))]"
              >
                <RefreshCw className="size-3.5" /> Заменить
              </button>
              <button
                type="button"
                onClick={() => updateBlock(block.id, { settings: {} })}
                className="flex items-center gap-1.5 rounded-[var(--rf-radius)] bg-[var(--rf-field-bg)] px-3 py-1.5 text-sm font-medium text-[var(--rf-danger)] transition-colors hover:bg-[color-mix(in_oklab,var(--rf-field-bg)_92%,var(--rf-danger))]"
              >
                <Trash2 className="size-3.5" /> Удалить
              </button>
            </div>
          )}
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
