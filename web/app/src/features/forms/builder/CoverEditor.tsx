import { useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ImageIcon, ImagePlus, MoveVertical, Palette, RefreshCw, Trash2 } from 'lucide-react'

import { coverY } from '@entities/formSchema'
import { CoverBand, LogoMark } from '@fields/pageChrome'

import { ColorPicker } from './ColorPicker'
import { nextCoverY } from './coverDrag'
import { uploadImage } from './mediaUpload'
import { useBuilderStore } from './storeContext'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// Хром страницы в РЕДАКТОРЕ: та же обложка и тот же логотип, что увидит респондент
// (общие CoverBand/LogoMark из @fields), плюс жесты автора поверх них. Ни одного
// правила ВИДА обложки здесь нет — разъехавшийся редактор это WYSIWYG, который врёт.
// Всё, что добавляет этот файл, — оверлеи с кнопками, загрузка и перетаскивание.

// Палитра обложек: плотные, но не кричащие тона — обложка это фон под заголовком, а
// не акцент. Свободный цвет остаётся доступен тем же ColorPicker, что у текста;
// палитра лишь убирает пустой холст при первом клике.
const COVER_COLORS = [
  '#e03e3e',
  '#d9730d',
  '#dfab01',
  '#0f7b6c',
  '#0b6e99',
  '#6940a5',
  '#ad1a72',
  '#64473a',
  '#787774',
  '#37352f',
] as const

const DEFAULT_COVER_COLOR = COVER_COLORS[4]

// Кнопка оверлея: общий вид «плашка поверх картинки» из ImageField, вынесенный сюда,
// чтобы пять кнопок не повторяли одну и ту же строку классов.
function OverlayButton({
  onClick,
  danger = false,
  children,
}: {
  onClick?: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[var(--rf-radius)] bg-[var(--rf-surface)] px-3 py-1.5 text-sm font-medium transition-colors ${
        danger
          ? 'text-[var(--rf-danger)] hover:bg-[color-mix(in_oklab,var(--rf-surface)_92%,var(--rf-danger))]'
          : 'text-[var(--rf-text)] hover:bg-[color-mix(in_oklab,var(--rf-surface)_92%,var(--rf-text))]'
      }`}
    >
      {children}
    </button>
  )
}

// Выбор цвета обложки: палитра плюс полноценный выборщик. Цвет применяется
// непрерывно, пока автор возит мышью, — выбирает он по результату, а не вслепую;
// история от этого не дробится (стор коалесит непрерывный подбор одним тегом).
function ColorButton({ current }: { current: string }) {
  const setCover = useBuilderStore((s) => s.setCover)
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-[var(--rf-radius)] bg-[var(--rf-surface)] px-3 py-1.5 text-sm font-medium text-[var(--rf-text)] transition-colors hover:bg-[color-mix(in_oklab,var(--rf-surface)_92%,var(--rf-text))]"
        >
          <Palette className="size-3.5" /> Цвет
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <ColorPicker
          initial={current}
          swatches={COVER_COLORS}
          removeLabel="Убрать обложку"
          onChange={(hex) => setCover({ color: hex })}
          onRemove={() => {
            setCover(undefined)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

// Полоса прогресса поверх обложки на время загрузки — та же плашка, что у картинки
// блока (ImageField): загрузка выглядит одинаково, где бы её ни начали.
function ProgressOverlay({ pct }: { pct: number }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/60">
      <div className="w-2/3 max-w-40">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-center text-xs text-muted-foreground">Загрузка… {pct}%</p>
      </div>
    </div>
  )
}

// FormChrome — обложка и логотип на полотне редактора со всеми жестами автора.
// Рисуется ДО колонки блоков: обложка идёт во всю ширину полотна, поэтому живёт вне
// коробки с максимальной шириной, а логотип — уже внутри неё (см. SlashEditor).
export function CoverArea({ formId }: { formId: string }) {
  const cover = useBuilderStore((s) => s.cover)
  const setCover = useBuilderStore((s) => s.setCover)
  const setCoverY = useBuilderStore((s) => s.setCoverY)

  const fileRef = useRef<HTMLInputElement>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Режим «изменить положение» и черновик сдвига. Жест ведётся в ЛОКАЛЬНОМ состоянии
  // и коммитится в стор ОДИН раз, на отпускании: запись на каждый кадр
  // перерисовывала бы всё полотно шестьдесят раз в секунду — ровно та ошибка,
  // которой выборщик цвета нагрузил TD-32, и повторять её вторым потребителем незачем.
  const [moving, setMoving] = useState(false)
  const [draftY, setDraftY] = useState<number | null>(null)
  const drag = useRef<{ pointerY: number; startY: number; y: number } | null>(null)

  if (!cover) return null

  const uploading = progress !== null

  function pick() {
    fileRef.current?.click()
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // позволить выбрать тот же файл повторно
    if (!file) return
    setError(null)
    setProgress(0)
    // Назначение cover: сервер оставит обложке её ширину (2000), а не ширину колонки.
    uploadImage(formId, file, { onProgress: setProgress }, 'cover')
      // Новая картинка приходит без сдвига: точка фокуса прежней ей не подходит —
      // это другое изображение с другой композицией.
      .then((imageKey) => setCover({ imageKey }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => setProgress(null))
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!moving || !cover?.imageKey) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointerY: e.clientY, startY: coverY(cover), y: coverY(cover) }
    setDraftY(coverY(cover))
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    d.y = nextCoverY(d.startY, d.pointerY, e.clientY, bandRef.current?.offsetHeight ?? 0)
    setDraftY(d.y)
  }

  // Коммит берёт значение из РЕФА, а не из состояния: между последним pointermove и
  // pointerup React может не успеть перерисоваться, и состояние отстанет на кадр —
  // жест тогда сохранил бы предпоследнее положение. Отставание состояния от жеста —
  // тот же класс дефектов, что нашёлся в фазе 14 на выделении текста.
  function onPointerUp() {
    const d = drag.current
    if (!d) return
    drag.current = null
    setCoverY(d.y)
    setDraftY(null)
  }

  return (
    <div className="group/cover relative">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />

      <div
        ref={bandRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={moving ? 'cursor-grab touch-none active:cursor-grabbing' : undefined}
      >
        {/* Общий вывод: в редакторе показывается ровно то, что увидит респондент.
            Во время жеста подставляется ЧЕРНОВИК сдвига — картинка едет за рукой,
            хотя в сторе ещё старое значение. */}
        <CoverBand cover={draftY === null ? cover : { ...cover, y: draftY }} />
      </div>

      {uploading && <ProgressOverlay pct={progress} />}

      {!uploading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/cover:opacity-100">
          <div className="pointer-events-auto flex items-center gap-2">
            {moving ? (
              <OverlayButton onClick={() => setMoving(false)}>
                <MoveVertical className="size-3.5" /> Готово
              </OverlayButton>
            ) : (
              <>
                <OverlayButton onClick={pick}>
                  <RefreshCw className="size-3.5" />
                  {cover.imageKey ? 'Заменить' : 'Картинка'}
                </OverlayButton>
                <ColorButton current={cover.color ?? DEFAULT_COVER_COLOR} />
                {/* Двигать можно только картинку: у цвета двигать нечего, и схема
                    такой документ отвергает. */}
                {cover.imageKey && (
                  <OverlayButton onClick={() => setMoving(true)}>
                    <MoveVertical className="size-3.5" /> Положение
                  </OverlayButton>
                )}
                <OverlayButton danger onClick={() => setCover(undefined)}>
                  <Trash2 className="size-3.5" /> Удалить
                </OverlayButton>
              </>
            )}
          </div>
        </div>
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

// LogoArea — логотип на полотне со своим оверлеем. Стоит ВНУТРИ колонки (в отличие
// от обложки), поэтому и компонент отдельный: они соседи по смыслу, но не по DOM.
export function LogoArea({ formId, over }: { formId: string; over: boolean }) {
  const logo = useBuilderStore((s) => s.logo)
  const setLogo = useBuilderStore((s) => s.setLogo)
  const fileRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!logo) return null

  function pick() {
    fileRef.current?.click()
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setProgress(0)
    uploadImage(formId, file, { onProgress: setProgress }, 'logo')
      .then((imageKey) => setLogo({ imageKey }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => setProgress(null))
  }

  return (
    <div className="group/logo relative w-fit">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />
      <LogoMark logo={logo} over={over} />
      {progress !== null ? (
        <ProgressOverlay pct={progress} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center gap-1 rounded-[var(--rf-radius)] bg-black/45 opacity-0 transition-opacity focus-within:opacity-100 group-hover/logo:opacity-100">
          <button
            type="button"
            onClick={pick}
            title="Заменить логотип"
            className="rounded p-1.5 text-white hover:bg-white/20"
          >
            <RefreshCw className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setLogo(undefined)}
            title="Удалить логотип"
            className="rounded p-1.5 text-white hover:bg-white/20"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      )}
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  )
}

// AddChrome — кнопки «завести», появляющиеся над заголовком по наведению на полотно.
//
// Стоят ВНЕ ПОТОКА (обёртка нулевой высоты + absolute), а не занимают место: иначе
// ритм полотна разъехался бы с превью и рендерером на высоту этой полосы. Из потока
// они заодно не могут «схлопнуться» на mousedown и съесть первый клик — тот дефект
// (TD-22) жил ровно у контрола, который место в потоке занимал.
export function AddChrome({ formId }: { formId: string }) {
  const cover = useBuilderStore((s) => s.cover)
  const logo = useBuilderStore((s) => s.logo)
  const setCover = useBuilderStore((s) => s.setCover)
  const setLogo = useBuilderStore((s) => s.setLogo)
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    uploadImage(formId, file, {}, 'logo')
      .then((imageKey) => setLogo({ imageKey }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
  }

  if (cover && logo) return null

  return (
    <div className="relative h-0">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />
      <div className="absolute bottom-1.5 left-0 flex items-center gap-4 whitespace-nowrap text-sm text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover/canvas:opacity-100">
        {!cover && (
          // Обложка заводится ЦВЕТОМ, а не диалогом выбора файла: один клик — и она
          // уже есть, а картинка ставится следующим жестом с той же полосы. Пустой
          // обложки-заглушки в схеме не бывает, поэтому «завести и выбрать потом»
          // выразить нечем.
          <button
            type="button"
            onClick={() => setCover({ color: DEFAULT_COVER_COLOR })}
            className="flex items-center gap-1.5 hover:text-foreground"
          >
            <ImageIcon className="size-4" /> Добавить обложку
          </button>
        )}
        {!logo && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 hover:text-foreground"
          >
            <ImagePlus className="size-4" /> Добавить логотип
          </button>
        )}
        {error && <span className="text-destructive">{error}</span>}
      </div>
    </div>
  )
}
