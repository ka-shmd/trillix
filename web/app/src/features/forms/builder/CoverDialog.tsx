import { useRef, useState, type ReactElement } from 'react'
import { ImageUp, Trash2 } from 'lucide-react'

import { humanError } from '../../../shared/api/errors'
import { ColorPicker } from './ColorPicker'
import { COVER_COLORS, DEFAULT_COVER_COLOR, coverFill } from './designEdit'
import { importImage, uploadImage, type FormIdSource } from './mediaUpload'
import { useBuilderStore } from './storeContext'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// CoverDialog — окно обложки: три способа залить полосу (файл, ссылка, цвет) и
// удаление. Одно на оба входа — кнопку «Изменить» на полотне и строку «Обложка» в
// шторке оформления (решение владельца 2026-09-14): обложка меняется одинаково,
// откуда бы её ни открыли.
//
// «Удалить» стоит в правом верхнем углу ВМЕСТО крестика (решение владельца): окно
// закрывается выбором, кликом мимо или Esc. У пустой обложки удалять нечего — угол
// пуст.
export function CoverDialog({ formId, children }: { formId: FormIdSource; children: ReactElement }) {
  const cover = useBuilderStore((s) => s.cover)
  const setCover = useBuilderStore((s) => s.setCover)
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <div className="flex min-h-7 items-center justify-between gap-4">
          <DialogTitle>Обложка</DialogTitle>
          {cover && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mr-2 text-destructive hover:text-destructive"
              onClick={() => {
                setCover(undefined)
                setOpen(false)
              }}
            >
              <Trash2 /> Удалить
            </Button>
          )}
        </div>
        <DialogDescription className="sr-only">
          Загрузите картинку, вставьте ссылку на неё или выберите цвет.
        </DialogDescription>
        <CoverTabs formId={formId} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

// Тело окна — отдельный компонент внутри Content: Radix размонтирует его при закрытии,
// поэтому вкладка, адрес и ошибка сбрасываются к умолчанию сами.
function CoverTabs({ formId, onDone }: { formId: FormIdSource; onDone: () => void }) {
  const cover = useBuilderStore((s) => s.cover)
  const setCover = useBuilderStore((s) => s.setCover)
  // Обложку цветом открывают на её цвете: скорее всего, его и подбирают.
  const [tab, setTab] = useState(cover?.color && !cover.imageKey ? 'color' : 'upload')

  // Новая картинка приходит без сдвига: точка фокуса прежней ей не подходит — это
  // другое изображение с другой композицией. Высота полосы сохраняется (coverFill).
  const applyImage = (imageKey: string) => {
    setCover(coverFill(cover, { imageKey }))
    onDone()
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <TabsList className="w-full">
        <TabsTrigger value="upload">Загрузить</TabsTrigger>
        <TabsTrigger value="link">Ссылка</TabsTrigger>
        <TabsTrigger value="color">Цвет</TabsTrigger>
      </TabsList>
      <TabsContent value="upload">
        <UploadTab formId={formId} onUploaded={applyImage} />
      </TabsContent>
      <TabsContent value="link">
        <LinkTab formId={formId} onUploaded={applyImage} />
      </TabsContent>
      <TabsContent value="color">
        {/* Цвет применяется на каждое движение и окна не закрывает: подбирают по
            результату на полосе. История не дробится — стор коалесит подбор одним
            тегом. */}
        <div className="w-64">
          <ColorPicker
            initial={cover?.color ?? DEFAULT_COVER_COLOR}
            swatches={COVER_COLORS}
            onChange={(hex) => setCover(coverFill(cover, { color: hex }))}
          />
        </div>
      </TabsContent>
    </Tabs>
  )
}

const IMAGE_HINT = 'PNG или JPEG, до 5 МБ'

// Зона загрузки: файл перетаскивают на неё или выбирают кликом. Подложка, а не рамка
// (DESIGN-SYSTEM §7); пунктир появляется, только пока над зоной несут файл.
function UploadTab({
  formId,
  onUploaded,
}: {
  formId: FormIdSource
  onUploaded: (imageKey: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  function send(file: File | undefined) {
    if (!file || progress !== null) return
    setError(null)
    setProgress(0)
    // Назначение cover: сервер оставит обложке её ширину (2000), а не ширину колонки.
    uploadImage(formId, file, { onProgress: setProgress }, 'cover')
      .then(onUploaded)
      .catch((err: unknown) => setError(humanError(err, 'Не удалось загрузить картинку')))
      .finally(() => setProgress(null))
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          send(e.target.files?.[0])
          e.target.value = '' // позволить выбрать тот же файл повторно
        }}
      />
      <button
        type="button"
        aria-busy={progress !== null}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          send(e.dataTransfer.files[0])
        }}
        className={cn(
          'flex h-40 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
          over ? 'border-primary bg-primary/5' : 'border-transparent bg-muted hover:bg-muted/70',
        )}
      >
        {progress !== null ? (
          <span className="flex w-2/3 flex-col gap-2">
            <Progress value={progress} />
            <span className="text-xs text-muted-foreground">Загрузка… {progress}%</span>
          </span>
        ) : (
          <>
            <ImageUp className="size-6 text-muted-foreground" />
            <span className="text-sm">Перетащите картинку сюда или нажмите, чтобы выбрать</span>
            <span className="text-xs text-muted-foreground">{IMAGE_HINT}</span>
          </>
        )}
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

// Картинка по ссылке. Скачивает её сервер и кладёт к себе (mediaUpload.importImage),
// поэтому причина отказа приходит от него словами — её и показываем.
function LinkTab({
  formId,
  onUploaded,
}: {
  formId: FormIdSource
  onUploaded: (imageKey: string) => void
}) {
  const [link, setLink] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = link.trim()

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed === '' || pending) return
        setPending(true)
        setError(null)
        importImage(formId, trimmed, 'cover')
          .then(onUploaded)
          .catch((err: unknown) =>
            setError(humanError(err, 'Не удалось загрузить картинку по ссылке')),
          )
          .finally(() => setPending(false))
      }}
    >
      <Label htmlFor="cover-link">Ссылка на картинку</Label>
      <div className="flex gap-2">
        {/* type="text", а не "url": у "url" браузер показывает свою подсказку
            проверки — латиницей и не нашими словами. Адрес проверяет сервер. */}
        <Input
          id="cover-link"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <Button type="submit" disabled={trimmed === '' || pending} className="shrink-0">
          {pending ? 'Загружаем…' : 'Применить'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{IMAGE_HINT}</p>
      )}
    </form>
  )
}
