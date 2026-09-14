import { useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ImageIcon, ImagePlus, MoveVertical, Palette, RefreshCw, Trash2 } from 'lucide-react'

import { coverY } from '@entities/formSchema'
import { CoverBand, LogoMark } from '@fields/pageChrome'

import { ColorPicker } from './ColorPicker'
import { coverOverflowPx, nextCoverY } from './coverDrag'
import { COVER_COLORS, DEFAULT_COVER_COLOR } from './designEdit'
import { uploadImage, type FormIdSource } from './mediaUpload'
import { useBuilderStore } from './storeContext'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { humanError } from '../../../shared/api/errors'

// Хром страницы в РЕДАКТОРЕ: та же обложка и тот же логотип, что увидит респондент
// (общие CoverBand/LogoMark из @fields), плюс жесты автора поверх них. Ни одного
// правила ВИДА обложки здесь нет — разъехавшийся редактор это WYSIWYG, который врёт.
// Всё, что добавляет этот файл, — оверлеи с кнопками, загрузка и перетаскивание.

// Кнопка оверлея поверх картинки автора — белая кнопка кабинета (`outline`), а не
// плашка в цветах темы формы (решение владельца 2026-09-14): это служебный контрол
// редактора, и выглядит он так же, как остальной хром. Тот же вид у картинки блока
// (ImageField).
const OVERLAY_DANGER = 'text-destructive hover:text-destructive'

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
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className={danger ? OVERLAY_DANGER : undefined}
    >
      {children}
    </Button>
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
        <Button type="button" variant="outline" size="sm">
          <Palette /> Цвет
        </Button>
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
// блока (ImageField): загрузка выглядит одинаково, где бы её ни начали. className —
// под форму того, что накрываем: у логотипа она круглая (см. LogoArea).
function ProgressOverlay({ pct, className = '' }: { pct: number; className?: string }) {
  return (
    <div
      className={`absolute inset-0 flex items-center justify-center bg-background/60 ${className}`}
    >
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
export function CoverArea({ formId }: { formId: FormIdSource }) {
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
  // overflow — ход жеста в пикселях (на сколько картинка перерастает полосу). Меряется
  // ОДИН раз, на нажатии: в середине протяжки ни размер полосы, ни размер картинки не
  // меняются, а замер на каждом кадре стоил бы принудительного пересчёта раскладки.
  const drag = useRef<{ pointerY: number; startY: number; y: number; overflow: number } | null>(
    null,
  )

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
      .catch((err: unknown) => setError(humanError(err, 'Ошибка загрузки')))
      .finally(() => setProgress(null))
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!moving || !cover?.imageKey) return
    const band = bandRef.current
    const img = band?.querySelector('img')
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      pointerY: e.clientY,
      startY: coverY(cover),
      y: coverY(cover),
      overflow: coverOverflowPx(
        img?.naturalWidth ?? 0,
        img?.naturalHeight ?? 0,
        band?.offsetWidth ?? 0,
        band?.offsetHeight ?? 0,
      ),
    }
    setDraftY(coverY(cover))
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    d.y = nextCoverY(d.startY, d.pointerY, e.clientY, d.overflow)
    setDraftY(d.y)
  }

  // Коммит берёт значение из РЕФА, а не из состояния: между последним pointermove и
  // pointerup React может не успеть перерисоваться, и состояние отстанет на кадр —
  // жест тогда сохранил бы предпоследнее положение. Отставание состояния от жеста —
  // тот же класс дефектов, что нашёлся в фазе 14 на выделении текста.
  //
  // Округление — ровно здесь: схема принимает только целые проценты, а во время жеста
  // значение дробное, чтобы картинка ехала плавно.
  function onPointerUp() {
    const d = drag.current
    if (!d) return
    drag.current = null
    setCoverY(Math.round(d.y))
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
        // select-none и touch-none — чтобы жест не соревновался с выделением текста
        // и прокруткой страницы; нативный drag самой картинки выключен в CoverBand.
        className={moving ? 'cursor-grab touch-none select-none active:cursor-grabbing' : undefined}
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
                <MoveVertical /> Готово
              </OverlayButton>
            ) : (
              <>
                <OverlayButton onClick={pick}>
                  <RefreshCw />
                  {cover.imageKey ? 'Заменить' : 'Картинка'}
                </OverlayButton>
                <ColorButton current={cover.color ?? DEFAULT_COVER_COLOR} />
                {/* Двигать можно только картинку: у цвета двигать нечего, и схема
                    такой документ отвергает. */}
                {cover.imageKey && (
                  <OverlayButton onClick={() => setMoving(true)}>
                    <MoveVertical /> Положение
                  </OverlayButton>
                )}
                <OverlayButton danger onClick={() => setCover(undefined)}>
                  <Trash2 /> Удалить
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

// Значок на логотипе: знак бывает мельче подписи, поэтому действие — значком, а
// подсказка обязательна и берёт текст у aria-label (DESIGN-SYSTEM §7).
function LogoAction({
  icon: Icon,
  label,
  className,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  className?: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={className}
          aria-label={label}
          onClick={onClick}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// LogoArea — логотип на полотне со своим оверлеем. Стоит ВНУТРИ колонки (в отличие
// от обложки), поэтому и компонент отдельный: они соседи по смыслу, но не по DOM.
export function LogoArea({ formId, over }: { formId: FormIdSource; over: boolean }) {
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
      .catch((err: unknown) => setError(humanError(err, 'Ошибка загрузки')))
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
      {/* Оверлеи скруглены ПО ЛОГОТИПУ (--rf-logo-radius), а не по контролам
          (--rf-radius): скругление логотипа задаёт автор, и при круглом знаке
          квадратное затемнение вылезает углами за его край. */}
      {progress !== null ? (
        <ProgressOverlay pct={progress} className="rounded-[var(--rf-logo-radius)]" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center gap-1 rounded-[var(--rf-logo-radius)] bg-foreground/35 opacity-0 transition-opacity focus-within:opacity-100 group-hover/logo:opacity-100">
          <LogoAction icon={RefreshCw} label="Заменить логотип" onClick={pick} />
          <LogoAction
            icon={Trash2}
            label="Удалить логотип"
            className={OVERLAY_DANGER}
            onClick={() => setLogo(undefined)}
          />
        </div>
      )}
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  )
}

// AddChrome — кнопки «завести», появляющиеся над заголовком по наведению на сам
// заголовок (group/title у обёртки в SlashEditor.tsx), а не на всё полотно: иначе
// они мигали бы при каждом движении мыши по форме, а не только у заголовка.
//
// Стоят ВНЕ ПОТОКА (обёртка нулевой высоты + absolute), а не занимают место: иначе
// ритм полотна разъехался бы с превью и рендерером на высоту этой полосы. Из потока
// они заодно не могут «схлопнуться» на mousedown и съесть первый клик — тот дефект
// (TD-22) жил ровно у контрола, который место в потоке занимал.
export function AddChrome({
  formId,
  onOpenDesign,
}: {
  formId: FormIdSource
  onOpenDesign: () => void
}) {
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
      .catch((err: unknown) => setError(humanError(err, 'Ошибка загрузки')))
  }

  // Кластер живёт, даже когда заводить нечего: «Оформление» — не «завести», оно
  // уместно всегда, и раньше кнопки исчезали целиком при обложке с логотипом.
  return (
    <div className="relative h-0">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />
      {/* bottom-0 + pb вместо bottom-N: зазор до заголовка становится ПАДДИНГОМ
        коробки, а не пустым местом снаружи неё — иначе курсор, идущий от заголовка к
        кнопкам, на середине пути покидал бы group/title (там ничего нет) и наведение
        гасло раньше, чем курсор доходил.

        pb-2/sm:pb-3 — не наугад: коробка растёт вверх от заголовка внутри промежутка
        «обложка → заголовок» (SlashEditor, pt-15/sm:pt-17 = 60/68px), а этот отступ
        держит строку ТЕКСТА кнопок БЛИЗКО к заголовку — 12/16px: малая кнопка
        высотой 28 добавляет под текстом свои 4. Остаток промежутка достаётся
        обложке сверху: воздуха там заметно больше, чем до заголовка, — так и
        задумано. Меняешь верхний отступ в SlashEditor/fields.css — держи pb здесь
        заметно меньше половины, иначе перекос обратно уедет к обложке.

        -ml-2 возвращает значок первой кнопки к левому краю заголовка: у ghost-кнопки
        видимая граница — значок и текст, а её поля (8 при значке) сдвигали бы их
        вправо. Кнопки стоят без gap — поля и есть зазор. */}
      <div className="absolute bottom-0 left-0 -ml-2 flex items-center whitespace-nowrap pb-2 sm:pb-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover/title:opacity-100">
        {!cover && (
          // Обложка заводится ЦВЕТОМ, а не диалогом выбора файла: один клик — и она
          // уже есть, а картинка ставится следующим жестом с той же полосы. Пустой
          // обложки-заглушки в схеме не бывает, поэтому «завести и выбрать потом»
          // выразить нечем.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setCover({ color: DEFAULT_COVER_COLOR })}
          >
            <ImageIcon /> Добавить обложку
          </Button>
        )}
        {!logo && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus /> Добавить логотип
          </Button>
        )}
        {/* «Оформление» — тот же вход, что кнопка-палитра в шапке: шторка одна, и
            второго её состояния здесь не заводится. Стоит рядом с обложкой и
            логотипом потому, что размеры того и другого настраиваются как раз в
            ней — жест «дотянуться до вида страницы» начинается в одном месте. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onOpenDesign}
        >
          <Palette /> Оформление
        </Button>
        {error && <span className="ml-2 text-sm text-destructive">{error}</span>}
      </div>
    </div>
  )
}
