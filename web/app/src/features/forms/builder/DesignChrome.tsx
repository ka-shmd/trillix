import { type ComponentProps, type ReactNode } from 'react'
import { ImageIcon, ImagePlus } from 'lucide-react'

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
import { cn } from '@/lib/utils'

import { CoverDialog, LogoDialog } from './CoverDialog'
import { patchCoverHeight, patchLogo } from './designEdit'
import { type FormIdSource } from './mediaUpload'
import { CONTROL, CONTROL_BOX, CONTROL_SHELL, LABEL } from './designControl'
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
      <Label htmlFor={id} className={LABEL}>
        {label}
      </Label>
      {children}
    </div>
  )
}

// Кнопка-превью: картинка, цвет или значок «добавить». Рост и край — те же, что у
// полей рядом (designControl), иначе строка выглядит собранной из двух разных.
//
// ПРОПСЫ ПРОБРАСЫВАЮТСЯ ЦЕЛИКОМ, и это не вкус: кнопка стоит под DialogTrigger
// asChild, а тот отдаёт свои обработчики и ref пропсами клонированного элемента.
// Компонент, который их не разложит на <button>, выглядит кнопкой и молча не
// нажимается; сторож — designChrome.test.tsx.
function ChromeButton({
  title,
  className,
  children,
  ...rest
}: ComponentProps<'button'> & { title: string }) {
  return (
    <button
      type="button"
      aria-label={title}
      {...rest}
      className={cn(
        `hover:bg-accent flex items-center justify-center overflow-hidden rounded-lg border ${CONTROL} ${CONTROL_SHELL}`,
        className,
      )}
    >
      {children}
    </button>
  )
}

// LogoRow — логотип: кнопка картинки плюс ширина, высота и скругление. Кнопка
// открывает окно логотипа (LogoDialog) — и у пустого, и у заполненного.
export function LogoRow({ formId }: { formId: FormIdSource }) {
  const logo = useBuilderStore((s) => s.logo)
  const setLogo = useBuilderStore((s) => s.setLogo)

  const num = (key: 'width' | 'height' | 'radius') => (n: number | undefined) => {
    if (logo) setLogo(patchLogo(logo, key, n))
  }

  return (
    <ChromeRow error={null}>
      {/* «Лого», а не «Логотип»: подпись стоит над кнопкой шириной в 32px, и полное
          слово растягивало бы ячейку втрое (решение владельца 2026-08-16). */}
      <Cell id="chrome-logo" label="Лого" className="shrink-0">
        {/* Тот же выбор, что по нажатию на знак на полотне: одно окно логотипа на оба
            входа (решение владельца 2026-09-14). */}
        <LogoDialog formId={formId}>
          <ChromeButton id="chrome-logo" title={logo ? 'Логотип' : 'Добавить логотип'} className="w-8">
            {logo ? (
              <img src={mediaSrc(logo.imageKey)} alt="" className="size-full object-cover" />
            ) : (
              <ImagePlus className="text-muted-foreground size-4" />
            )}
          </ChromeButton>
        </LogoDialog>
      </Cell>
      {/* Числа при отсутствующем логотипе выключены: настраивать размер тому, чего
          нет, нечему, а схема хранит их только внутри объекта логотипа. */}
      <Cell id="chrome-logo-w" label="Ширина">
        <NumberRow
          className={CONTROL_BOX}
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
          className={CONTROL_BOX}
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
          className={CONTROL_BOX}
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
// Кнопка открывает окно обложки и при пустой обложке тоже — в отличие от логотипа: у
// обложки три способа появиться (файл, ссылка, цвет), и выбирать между ними всё равно
// придётся. Окно то же, что у кнопки «Изменить» на полотне (CoverDialog).
export function CoverRow({ formId }: { formId: FormIdSource }) {
  const cover = useBuilderStore((s) => s.cover)
  const setCover = useBuilderStore((s) => s.setCover)

  return (
    <ChromeRow error={null}>
      {/* Кнопка обложки — ПРЯМОУГОЛЬНИК В ПОЛОВИНУ ШТОРКИ (решение владельца
          2026-08-16): обложка и на странице полоса во всю ширину, и квадрат 32px её
          не показывал — по нему нельзя было понять, что за картинка выбрана. */}
      <Cell id="chrome-cover" label="Обложка" className="w-1/2 shrink-0">
        <CoverDialog formId={formId}>
          <ChromeButton
            id="chrome-cover"
            title={cover ? 'Обложка' : 'Добавить обложку'}
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
        </CoverDialog>
      </Cell>
      <Cell id="chrome-cover-h" label="Высота, % экрана">
        <NumberRow
          className={CONTROL_BOX}
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
