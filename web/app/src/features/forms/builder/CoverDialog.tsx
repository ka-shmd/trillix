import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Trash2, Upload } from 'lucide-react'

import { humanError } from '../../../shared/api/errors'
import { ColorPicker } from './ColorPicker'
import { COVER_COLORS, DEFAULT_COVER_COLOR, coverFill } from './designEdit'
import { importImage, uploadImage, type FormIdSource, type UploadPurpose } from './mediaUpload'
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
export function CoverDialog({ formId, children }: { formId: FormIdSource; children: ReactElement }) {
  const cover = useBuilderStore((s) => s.cover)
  const setCover = useBuilderStore((s) => s.setCover)

  return (
    <ImageDialog
      label="Обложка"
      formId={formId}
      purpose="cover"
      hint="Рекомендуемая ширина — от 1500 пикселей"
      removable={cover !== undefined}
      // Новая картинка приходит без сдвига: точка фокуса прежней ей не подходит — это
      // другое изображение с другой композицией. Высота полосы сохраняется (coverFill).
      onImage={(imageKey) => setCover(coverFill(cover, { imageKey }))}
      onRemove={() => setCover(undefined)}
      // Обложку цветом открывают на её цвете: скорее всего, его и подбирают.
      initialTab={cover?.color && !cover.imageKey ? 'color' : 'upload'}
      color={
        // Цвет применяется на каждое движение и окна не закрывает: подбирают по
        // результату на полосе. История не дробится — стор коалесит подбор одним тегом.
        <div className="w-64">
          <ColorPicker
            initial={cover?.color ?? DEFAULT_COVER_COLOR}
            swatches={COVER_COLORS}
            onChange={(hex) => setCover(coverFill(cover, { color: hex }))}
          />
        </div>
      }
    >
      {children}
    </ImageDialog>
  )
}

// LogoDialog — окно логотипа: файл или ссылка и удаление, без цвета. Открывается
// нажатием на сам знак на полотне (решение владельца 2026-09-14).
export function LogoDialog({ formId, children }: { formId: FormIdSource; children: ReactElement }) {
  const logo = useBuilderStore((s) => s.logo)
  const setLogo = useBuilderStore((s) => s.setLogo)

  return (
    <ImageDialog
      label="Логотип"
      formId={formId}
      purpose="logo"
      hint="Рекомендуемый размер — от 300 × 300 пикселей"
      removable={logo !== undefined}
      // Размеры переживают замену картинки: автор настраивал их под место на странице,
      // а не под конкретный файл (так же в шторке, DesignChrome).
      onImage={(imageKey) => setLogo({ ...logo, imageKey })}
      onRemove={() => setLogo(undefined)}
    >
      {children}
    </ImageDialog>
  )
}

type ImageTab = 'upload' | 'link' | 'color'

// ImageDialog — общий вид окна картинки хрома страницы.
//
// Вид — по референсу владельца: заголовка нет, шапка окна — ряд вкладок с чертой под
// активной, «Удалить» в том же ряду у правого края ВМЕСТО крестика; окно закрывается
// выбором, кликом мимо или Esc.
function ImageDialog({
  label,
  children,
  ...body
}: ImageBodyProps & { label: string; children: ReactElement }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-2xl">
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogDescription className="sr-only">
          {body.color
            ? 'Загрузите картинку, вставьте ссылку на неё или выберите цвет.'
            : 'Загрузите картинку или вставьте ссылку на неё.'}
        </DialogDescription>
        <ImageTabs {...body} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

interface ImageBodyProps {
  formId: FormIdSource
  purpose: UploadPurpose
  // Первая строка подсказки зоны загрузки: рекомендуемый размер под назначение.
  hint: string
  removable: boolean
  onImage: (imageKey: string) => void
  onRemove: () => void
  initialTab?: ImageTab
  // Содержимое вкладки «Цвет»; нет — нет и вкладки.
  color?: ReactNode
}

// Вкладка шапки: текст с чертой под активной. Черта — `after` вендоренного варианта
// line, опущенная на линию шапки (-bottom-px), а не на штатные 5px ниже триггера.
// Сдвиг задан ТЕМ ЖЕ вариантом, что у вендора, иначе tailwind-merge его не сольёт.
const TAB =
  'flex-none px-0 font-semibold group-data-[orientation=horizontal]/tabs:after:-bottom-px'

// Тело окна — отдельный компонент внутри Content: Radix размонтирует его при закрытии,
// поэтому вкладка, адрес и ошибка сбрасываются к умолчанию сами.
function ImageTabs({
  formId,
  purpose,
  hint,
  removable,
  onImage,
  onRemove,
  initialTab = 'upload',
  color,
  onDone,
}: ImageBodyProps & { onDone: () => void }) {
  const [tab, setTab] = useState<string>(initialTab)
  const applyImage = (imageKey: string) => {
    onImage(imageKey)
    onDone()
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-0">
      <div className="flex items-center justify-between gap-4 border-b px-6">
        <TabsList
          variant="line"
          className="gap-4 p-0 group-data-[orientation=horizontal]/tabs:h-12"
        >
          <TabsTrigger value="upload" className={TAB}>
            Загрузить
          </TabsTrigger>
          <TabsTrigger value="link" className={TAB}>
            Ссылка
          </TabsTrigger>
          {color !== undefined && (
            <TabsTrigger value="color" className={TAB}>
              Цвет
            </TabsTrigger>
          )}
        </TabsList>
        {/* Удалять нечего — место пустует. Деструктивное приглушено и краснеет на
            наведении (DESIGN-SYSTEM §7). */}
        {removable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-mr-2 text-muted-foreground hover:text-destructive"
            onClick={() => {
              onRemove()
              onDone()
            }}
          >
            <Trash2 /> Удалить
          </Button>
        )}
      </div>
      {/* Высота тела одна на все вкладки (h-90 зоны загрузки): окно не прыгает при
          переключении. */}
      <div className="p-6">
        <TabsContent value="upload">
          <UploadTab formId={formId} purpose={purpose} hint={hint} onUploaded={applyImage} />
        </TabsContent>
        <TabsContent value="link" className="min-h-90">
          <LinkTab formId={formId} purpose={purpose} onUploaded={applyImage} />
        </TabsContent>
        {color !== undefined && (
          <TabsContent value="color" className="min-h-90">
            {color}
          </TabsContent>
        )}
      </div>
    </Tabs>
  )
}

const IMAGE_LIMIT = 'PNG или JPEG, до 5 МБ'

interface SourceTabProps {
  formId: FormIdSource
  purpose: UploadPurpose
  onUploaded: (imageKey: string) => void
}

// Зона загрузки: файл перетаскивают на неё или выбирают кликом. Пунктирная рамка —
// решение владельца по референсу: это жанр «сюда бросают файл», а не блок страницы,
// поэтому правило «плоскость вместо рамки» (DESIGN-SYSTEM §7) на неё не распространяется.
function UploadTab({ formId, purpose, hint, onUploaded }: SourceTabProps & { hint: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  function send(file: File | undefined) {
    if (!file || progress !== null) return
    setError(null)
    setProgress(0)
    // Назначение решает потолок ширины на сервере: обложке 2000, логотипу 512.
    uploadImage(formId, file, { onProgress: setProgress }, purpose)
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
          'flex h-90 w-full flex-col items-center justify-center rounded-lg border border-dashed px-6 text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
          over ? 'border-primary bg-primary/5' : 'border-muted-foreground/40 hover:bg-muted/50',
        )}
      >
        {progress !== null ? (
          <span className="flex w-2/3 max-w-64 flex-col gap-2">
            <Progress value={progress} />
            <span className="text-xs text-muted-foreground">Загрузка… {progress}%</span>
          </span>
        ) : (
          <>
            <Upload className="size-12 text-muted-foreground" />
            <span className="mt-4 text-sm font-semibold">
              Нажмите, чтобы выбрать файл, или перетащите его сюда
            </span>
            <span className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground">
              <span>{hint}</span>
              <span>{IMAGE_LIMIT}</span>
            </span>
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
function LinkTab({ formId, purpose, onUploaded }: SourceTabProps) {
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
        importImage(formId, trimmed, purpose)
          .then(onUploaded)
          .catch((err: unknown) =>
            setError(humanError(err, 'Не удалось загрузить картинку по ссылке')),
          )
          .finally(() => setPending(false))
      }}
    >
      <Label htmlFor={`${purpose}-link`}>Ссылка на картинку</Label>
      <div className="flex gap-2">
        {/* type="text", а не "url": у "url" браузер показывает свою подсказку
            проверки — латиницей и не нашими словами. Адрес проверяет сервер. */}
        <Input
          id={`${purpose}-link`}
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
        <p className="text-xs text-muted-foreground">{IMAGE_LIMIT}</p>
      )}
    </form>
  )
}
