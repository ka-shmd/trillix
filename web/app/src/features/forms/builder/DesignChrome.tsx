import { useState, type ComponentProps, type ReactNode } from 'react'
import { ImageIcon, ImagePlus, Loader2, RefreshCw, Trash2 } from 'lucide-react'

import {
  COVER_HEIGHT_MAX,
  COVER_HEIGHT_MIN,
  DEFAULT_COVER_HEIGHT,
  DEFAULT_LOGO_HEIGHT,
  DEFAULT_LOGO_RADIUS,
  DEFAULT_LOGO_WIDTH,
  LOGO_RADIUS_MAX,
  LOGO_RADIUS_MIN,
  LOGO_SIZE_MAX,
  LOGO_SIZE_MIN,
} from '@entities/formSchema'
import { mediaSrc } from '@fields/media'

import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { ColorPicker } from './ColorPicker'
import {
  COVER_COLORS,
  DEFAULT_COVER_COLOR,
  coverFill,
  patchCoverHeight,
  patchLogo,
} from './designEdit'
import { uploadImage, type UploadPurpose } from './mediaUpload'
import { NumberRow } from './NumberRow'
import { useBuilderStore } from './storeContext'

// ХРОМ СТРАНИЦЫ В ПАНЕЛИ «ОФОРМЛЕНИЕ» — строки «Логотип» и «Обложка» в секции
// «Лэйаут» (решение владельца 2026-08-16).
//
// Второе место, откуда заводится и правится тот же хром: первое — жесты на полотне
// (CoverEditor.tsx), и они остаются. Разница в поводе. На полотне автор работает с
// КАРТИНКОЙ там, где она лежит («заменить», «подвинуть»); в панели он подбирает
// РАЗМЕРЫ рядом с остальной геометрией страницы — шириной колонки и кеглем, от
// которых размер логотипа и высота обложки неотделимы.
//
// Правила вида здесь снова нет ни одного: кнопки показывают ту же картинку через
// mediaSrc, а размеры уезжают в схему и рисуются fields.css на всех трёх
// поверхностях (pageChrome.tsx).

// Загрузка картинки хрома. Хук, а не две копии: у логотипа и обложки различаются
// только назначение файла и то, что делать с готовым ключом.
//
// ДИАЛОГ ВЫБОРА ФАЙЛА ОТКРЫВАЕТСЯ СОЗДАННЫМ НА МЕСТЕ input, а не спрятанным в
// разметке (как на полотне, CoverEditor): спрятанный требует ref, а ref, приехавший
// из хука, читается в рендере — это ловит react-hooks/refs, и законного обхода у него
// нет. Элемент живёт ровно до выбора файла и в документ не попадает.
function useChromeUpload(
  formId: string,
  purpose: UploadPurpose,
  apply: (imageKey: string) => void,
) {
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  function pick() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      setError(null)
      setProgress(0)
      uploadImage(formId, file, { onProgress: setProgress }, purpose)
        .then(apply)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
        .finally(() => setProgress(null))
    })
    input.click()
  }

  return { pick, progress, error }
}

// Строка хрома: кнопка картинки слева, числа справа. Своя раскладка, а не сетка
// группы в две колонки: контролов в строке четыре, и в половину панели они не встают.
//
// ПОДПИСЬ — У КАЖДОГО КОНТРОЛА СВОЯ (решение владельца 2026-08-16), общей подписи над
// строкой нет: «Логотип» над четырьмя контролами читалась как заголовок подсекции, а
// не как имя кнопки, и три числа под ней оставались безымянными.
function ChromeRow({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <div className="col-span-2 grid gap-1">
      {/* items-end: подписи у контролов разной длины, выравнивание по низу ставит в
          один ряд сами контролы, а не их подписи. */}
      <div className="flex items-end gap-2">{children}</div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}

// Ячейка строки: подпись над контролом, как у остальных настроек панели.
function Cell({
  id,
  label,
  className = 'min-w-0 flex-1',
  children,
}: {
  id: string
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`grid gap-1 ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground text-[10px] font-normal">
        {label}
      </Label>
      {children}
    </div>
  )
}

// Кнопка-превью: картинка, цвет или значок «добавить». Высота — та же, что у полей
// рядом (h-8), иначе строка выглядит собранной из двух разных.
//
// ПРОПСЫ ПРОБРАСЫВАЮТСЯ ЦЕЛИКОМ, и это не вкус: кнопка стоит под PopoverTrigger
// asChild, а тот отдаёт свои обработчики и ref пропсами клонированного элемента.
// Компонент, который их не разложит на <button>, выглядит кнопкой и молча не
// нажимается; сторож — designChrome.test.tsx.
function ChromeButton({
  title,
  busy,
  className,
  children,
  ...rest
}: ComponentProps<'button'> & { title: string; busy: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      {...rest}
      className={cn(
        'border-input hover:bg-accent flex h-8 items-center justify-center overflow-hidden rounded-md border',
        className,
      )}
    >
      {busy ? <Loader2 className="text-muted-foreground size-4 animate-spin" /> : children}
    </button>
  )
}

// LogoRow — логотип: кнопка картинки плюс ширина, высота и скругление.
//
// Пустая кнопка ведёт СРАЗУ в диалог выбора файла, а заполненная открывает меню
// «заменить/удалить»: у логотипа без картинки других состояний нет, и лишний шаг
// перед единственным действием был бы шагом в никуда.
export function LogoRow({ formId }: { formId: string }) {
  const logo = useBuilderStore((s) => s.logo)
  const setLogo = useBuilderStore((s) => s.setLogo)
  const [open, setOpen] = useState(false)
  const upload = useChromeUpload(formId, 'logo', (imageKey) =>
    // Размеры переживают замену картинки: автор настраивал их под место на странице,
    // а не под конкретный файл.
    setLogo({ ...logo, imageKey }),
  )

  const num = (key: 'width' | 'height' | 'radius') => (n: number | undefined) => {
    if (logo) setLogo(patchLogo(logo, key, n))
  }

  return (
    <ChromeRow error={upload.error}>
      {/* «Лого», а не «Логотип»: подпись стоит над кнопкой шириной в 32px, и полное
          слово растягивало бы ячейку втрое (решение владельца 2026-08-16). */}
      <Cell id="chrome-logo" label="Лого" className="shrink-0">
        {logo ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <ChromeButton id="chrome-logo" title="Логотип" busy={upload.progress !== null} className="w-8">
                <img src={mediaSrc(logo.imageKey)} alt="" className="size-full object-cover" />
              </ChromeButton>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-1">
              <MenuItem
                onClick={() => {
                  setOpen(false)
                  upload.pick()
                }}
              >
                <RefreshCw className="size-4" /> Заменить картинку
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  setOpen(false)
                  setLogo(undefined)
                }}
              >
                <Trash2 className="size-4" /> Удалить логотип
              </MenuItem>
            </PopoverContent>
          </Popover>
        ) : (
          <ChromeButton
            id="chrome-logo"
            title="Добавить логотип"
            busy={upload.progress !== null}
            className="w-8"
            onClick={upload.pick}
          >
            <ImagePlus className="text-muted-foreground size-4" />
          </ChromeButton>
        )}
      </Cell>
      {/* Числа при отсутствующем логотипе выключены: настраивать размер тому, чего
          нет, нечему, а схема хранит их только внутри объекта логотипа. */}
      <Cell id="chrome-logo-w" label="Ширина">
        <NumberRow
          id="chrome-logo-w"
          value={logo?.width}
          fallback={DEFAULT_LOGO_WIDTH}
          min={LOGO_SIZE_MIN}
          max={LOGO_SIZE_MAX}
          disabled={!logo}
          onChange={num('width')}
        />
      </Cell>
      <Cell id="chrome-logo-h" label="Высота">
        <NumberRow
          id="chrome-logo-h"
          value={logo?.height}
          fallback={DEFAULT_LOGO_HEIGHT}
          min={LOGO_SIZE_MIN}
          max={LOGO_SIZE_MAX}
          disabled={!logo}
          onChange={num('height')}
        />
      </Cell>
      <Cell id="chrome-logo-r" label="Радиус">
        <NumberRow
          id="chrome-logo-r"
          value={logo?.radius}
          fallback={DEFAULT_LOGO_RADIUS}
          min={LOGO_RADIUS_MIN}
          max={LOGO_RADIUS_MAX}
          disabled={!logo}
          onChange={num('radius')}
        />
      </Cell>
    </ChromeRow>
  )
}

// CoverRow — обложка: кнопка наполнения плюс высота полосы в процентах окна.
//
// Кнопка ведёт в меню и при пустой обложке тоже — в отличие от логотипа: у обложки
// два способа появиться (цвет и картинка), и выбирать между ними всё равно придётся.
export function CoverRow({ formId }: { formId: string }) {
  const cover = useBuilderStore((s) => s.cover)
  const setCover = useBuilderStore((s) => s.setCover)
  const [open, setOpen] = useState(false)
  const upload = useChromeUpload(formId, 'cover', (imageKey) =>
    setCover(coverFill(cover, { imageKey })),
  )

  return (
    <ChromeRow error={upload.error}>
      {/* Кнопка обложки — ПРЯМОУГОЛЬНИК В ПОЛОВИНУ ШТОРКИ (решение владельца
          2026-08-16): обложка и на странице полоса во всю ширину, и квадрат 32px её
          не показывал — по нему нельзя было понять, что за картинка выбрана. */}
      <Cell id="chrome-cover" label="Обложка" className="w-1/2 shrink-0">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <ChromeButton
              id="chrome-cover"
              title={cover ? 'Обложка' : 'Добавить обложку'}
              busy={upload.progress !== null}
              className="w-full"
            >
              {cover?.imageKey ? (
                <img src={mediaSrc(cover.imageKey)} alt="" className="size-full object-cover" />
              ) : cover?.color ? (
                <span className="size-full" style={{ backgroundColor: cover.color }} />
              ) : (
                <ImageIcon className="text-muted-foreground size-4" />
              )}
            </ChromeButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
          <MenuItem
            onClick={() => {
              setOpen(false)
              upload.pick()
            }}
          >
            <ImagePlus className="size-4" /> {cover?.imageKey ? 'Заменить картинку' : 'Картинка…'}
          </MenuItem>
          {/* Тот же выборщик, что на полотне и у цветов оформления: обложка красится
              одним жестом и той же палитрой, где бы её ни красили. */}
          <ColorPicker
            initial={cover?.color ?? DEFAULT_COVER_COLOR}
            swatches={COVER_COLORS}
            removeLabel="Убрать обложку"
            onChange={(hex) => setCover(coverFill(cover, { color: hex }))}
            onRemove={() => {
              setOpen(false)
              setCover(undefined)
            }}
          />
          </PopoverContent>
        </Popover>
      </Cell>
      <Cell id="chrome-cover-h" label="Высота, % экрана">
        <NumberRow
          id="chrome-cover-h"
          value={cover?.height}
          fallback={DEFAULT_COVER_HEIGHT}
          min={COVER_HEIGHT_MIN}
          max={COVER_HEIGHT_MAX}
          disabled={!cover}
          onChange={(n) => {
            if (cover) setCover(patchCoverHeight(cover, n))
          }}
        />
      </Cell>
    </ChromeRow>
  )
}

// Пункт меню в поповере — вид кнопки shadcn ghost, но без вендоренного DropdownMenu:
// пунктов два, и они соседствуют с выборщиком цвета внутри одного поповера.
function MenuItem({
  children,
  danger = false,
  onClick,
}: {
  children: ReactNode
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm ${
        danger ? 'text-destructive' : ''
      }`}
    >
      {children}
    </button>
  )
}
