import { useEffect, useState, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

import {
  DESIGN_ALIGNS,
  DESIGN_BUTTON_SIZES,
  DESIGN_BUTTON_VARIANTS,
  DESIGN_BUTTON_WIDTHS,
  DESIGN_DENSITIES,
  DESIGN_OUTLINES,
  DESIGN_THEMES,
  DESIGN_WIDTHS,
  MAX_FONT_SIZE,
  MAX_RADIUS,
  MIN_FONT_SIZE,
  MIN_RADIUS,
} from '@entities/formSchema'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

import { ColorPicker } from './ColorPicker'
import { PALETTE_FIELDS, patch, SWATCHES } from './designEdit'
import { currentTheme, withTheme } from './designTheme'
import { darkThemeColorClash, lowContrast } from './designWarnings'
import { useBuilderStore } from './storeContext'

// ПАНЕЛЬ «ОФОРМЛЕНИЕ» — ВЫЕЗЖАЮЩАЯ ШТОРКА (фаза 22; вид согласован с владельцем
// 2026-08-09 по образцу Tally).
//
// Шторка, а не отдельный режим вместо полотна, по одной причине, и она же главная:
// автор смотрит НЕ на панель, а на форму рядом. Оформление меняется у него на
// глазах — полотно остаётся видимым, перерисовывается и остаётся редактируемым.
// Панель, закрывающая полотно, показывала бы результат только после выхода из неё,
// то есть превращала бы подбор вида в угадывание.
//
// Отсюда два отступления от вендоренного Sheet:
//   • modal={false} — фокус не запирается, полотно кликабельно;
//   • showOverlay={false} — затемнение убивает ровно тот смысл, ради которого
//     шторка и выбрана (добавка к компоненту, см. sheet.tsx).
//
// ОБОЛОЧКА СЪЕЗЖАЕТ ВМЕСТЕ СО ШТОРКОЙ, а не накрывается ею: пока панель открыта,
// маршрутная коробка (`SidebarInset` в routes/_app.tsx) держит правый отступ в её
// ширину, поэтому шапка и полотно сдвигаются, а колонка формы перецентрируется.
//
// СОХРАНЕНИЕ — АВТОСЕЙВОМ, в отличие от «Настроек формы» с их кнопкой. Разница не в
// непоследовательности: настройки это поля ввода, где человек ждёт «применить», а
// оформление — жесты выбора с немедленным результатом. Кнопка «Сохранить» под
// дропдауном означала бы, что выбранное ещё не выбрано.
//
// ДЕФОЛТ ВЕЗДЕ ХРАНИТСЯ ОТСУТСТВИЕМ КЛЮЧА: выбор «Обычная ширина», «Тень», «Заливка»
// не пишет в схему ничего, а снимает поле. Форма, у которой настройку включили и
// вернули обратно, обязана стать байт в байт прежней — иначе документ отличается от
// исходного при одинаковом виде, и это расхождение живёт вечно.
export function DesignDrawer({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const design = useBuilderStore((s) => s.design)
  const setDesign = useBuilderStore((s) => s.setDesign)
  // Подписка на blocks — только ради счётчика крашеного текста. Панель живёт в
  // портале и полотно своей перерисовкой не трогает, но сама она перерисуется на
  // каждый символ: счётчик считается по всему документу, поэтому память о фазе 21
  // тут уместна — если панель начнёт тормозить набор, первым делом мемоизировать
  // именно этот подсчёт.
  const blocks = useBuilderStore((s) => s.blocks)
  const clearTextColors = useBuilderStore((s) => s.clearTextColors)

  // Обе тонкости выбора темы («светлая = отсутствие ключа», «пустой остаток =
  // undefined») живут в designTheme.ts отдельным модулем — ровно чтобы их можно было
  // проверить тестом: Radix Select в happy-dom не открывается вовсе (STATUS.md), и
  // через разметку эта логика непокрываема. По той же причине отдельно живут patch()
  // и обе проверки-предупреждения.
  const theme = currentTheme(design)
  const clash = darkThemeColorClash(design, blocks)
  const contrast = lowContrast(design)

  // Ширина открытой шторки уезжает на корень документа: открывают её глубоко в
  // фиче, а съезжает оболочка маршрута, и тащить проп через три слоя ради этого
  // незачем. Снимается в cleanup — иначе закрытая панель оставила бы страницу с
  // вечным отступом справа.
  useEffect(() => {
    if (!open) return
    const root = document.documentElement
    root.style.setProperty('--app-drawer', DRAWER_WIDTH)
    return () => {
      root.style.removeProperty('--app-drawer')
    }
  }, [open])

  const set = (
    group: 'palette' | 'layout' | 'controls' | 'button',
    key: string,
    value: string | number | undefined,
    // Ключ коалесинга — только у непрерывных жестов (выборщик цвета зовёт onChange
    // раз в кадр). Дискретный выбор в дропдауне остаётся отдельным шагом отмены:
    // склеивать там нечего, а склеенный он «проглатывал» бы соседний.
    tag?: string,
  ) => setDesign(patch(design, group, key, value), tag)

  // dflt — выбор значения по умолчанию снимает ключ, а не пишет его.
  const dflt = (value: string, fallback: string) => (value === fallback ? undefined : value)

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        showOverlay={false}
        // Шторка не должна забирать фокус с полотна при открытии: автор пришёл
        // смотреть на форму, а не печатать в панели.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Клик по полотну — обычный клик по полотну, а не «закрыть панель»: иначе
        // любая правка формы при открытой шторке захлопывала бы её.
        onInteractOutside={(e) => e.preventDefault()}
        // Длительность выровнена с оболочкой (300 мс в обе стороны против штатных
        // 500/300 у Sheet): панель и шапка обязаны ехать одним движением, иначе
        // видно, что это два разных элемента.
        className="w-80 gap-0 overflow-y-auto sm:max-w-80 data-[state=closed]:duration-300 data-[state=open]:duration-300"
        aria-label="Оформление формы"
      >
        <SheetHeader>
          <SheetTitle>Оформление</SheetTitle>
          <SheetDescription>Как форма выглядит у респондента.</SheetDescription>
        </SheetHeader>

        <div className="grid gap-5 px-4 pb-10">
          <Field label="Тема" id="design-theme">
            <Choice
              id="design-theme"
              value={theme}
              options={DESIGN_THEMES}
              titles={THEME_TITLES}
              onChange={(next) => setDesign(withTheme(design, next as 'light' | 'dark'))}
            />
          </Field>

          {clash > 0 && (
            <Warning>
              {clash} {plural(clash, 'кусок', 'куска', 'кусков')} текста покрашены вручную —
              на тёмном фоне цвет может пропасть. Внутри строки он абсолютный и за темой
              не следует.
              <Button variant="outline" size="sm" className="mt-2" onClick={clearTextColors}>
                Снять цвета текста
              </Button>
            </Warning>
          )}

          <Separator />

          <Group title="Цвета">
            {PALETTE_FIELDS.map(({ key, title }) => (
              <ColorRow
                key={key}
                title={title}
                value={design?.palette?.[key]}
                // Тег на КАЖДЫЙ цвет свой: подбор акцента и следом подбор фона —
                // два разных решения автора и два шага отмены.
                onChange={(hex) => set('palette', key, hex, `design:palette:${key}`)}
                onRemove={() => set('palette', key, undefined)}
              />
            ))}
            {contrast !== null && (
              <Warning>
                Контраст текста к фону — {contrast.toFixed(1)}:1, ниже рекомендованных 4,5:1.
                Такой текст трудно читать на телефоне и при ярком свете.
              </Warning>
            )}
          </Group>

          <Separator />

          <Group title="Лэйаут">
            <Field label="Ширина колонки" id="design-width">
              <Choice
                id="design-width"
                value={design?.layout?.width ?? 'normal'}
                options={DESIGN_WIDTHS}
                titles={WIDTH_TITLES}
                onChange={(v) => set('layout', 'width', dflt(v, 'normal'))}
              />
            </Field>
            <Field label="Размер шрифта" id="design-font-size">
              <NumberRow
                id="design-font-size"
                value={design?.layout?.fontSize}
                fallback={16}
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                onChange={(n) => set('layout', 'fontSize', n)}
              />
            </Field>
            <Field label="Плотность" id="design-density">
              <Choice
                id="design-density"
                value={design?.layout?.density ?? 'normal'}
                options={DESIGN_DENSITIES}
                titles={DENSITY_TITLES}
                onChange={(v) => set('layout', 'density', dflt(v, 'normal'))}
              />
            </Field>
            <Field label="Выравнивание" id="design-align">
              <Choice
                id="design-align"
                value={design?.layout?.align ?? 'left'}
                options={DESIGN_ALIGNS}
                titles={ALIGN_TITLES}
                onChange={(v) => set('layout', 'align', dflt(v, 'left'))}
              />
            </Field>
          </Group>

          <Separator />

          <Group title="Поля">
            <Field label="Скругление" id="design-radius">
              <NumberRow
                id="design-radius"
                value={design?.controls?.radius}
                fallback={8}
                min={MIN_RADIUS}
                max={MAX_RADIUS}
                onChange={(n) => set('controls', 'radius', n)}
              />
            </Field>
            <Field label="Контур" id="design-outline">
              <Choice
                id="design-outline"
                value={design?.controls?.outline ?? 'shadow'}
                options={DESIGN_OUTLINES}
                titles={OUTLINE_TITLES}
                onChange={(v) => set('controls', 'outline', dflt(v, 'shadow'))}
              />
            </Field>
          </Group>

          <Separator />

          <Group title="Кнопка отправки">
            <Field label="Вид" id="design-btn-variant">
              <Choice
                id="design-btn-variant"
                value={design?.button?.variant ?? 'solid'}
                options={DESIGN_BUTTON_VARIANTS}
                titles={BUTTON_VARIANT_TITLES}
                onChange={(v) => set('button', 'variant', dflt(v, 'solid'))}
              />
            </Field>
            <Field label="Ширина" id="design-btn-width">
              <Choice
                id="design-btn-width"
                value={design?.button?.width ?? 'auto'}
                options={DESIGN_BUTTON_WIDTHS}
                titles={BUTTON_WIDTH_TITLES}
                onChange={(v) => set('button', 'width', dflt(v, 'auto'))}
              />
            </Field>
            <Field label="Положение" id="design-btn-align">
              <Choice
                id="design-btn-align"
                value={design?.button?.align ?? 'left'}
                options={DESIGN_ALIGNS}
                titles={ALIGN_TITLES}
                onChange={(v) => set('button', 'align', dflt(v, 'left'))}
                // Растянутой кнопке положение неприменимо: во всю ширину она уже
                // занимает колонку, и «слева» с «по центру» означали бы одно и то же.
                disabled={design?.button?.width === 'full'}
              />
            </Field>
            <Field label="Размер" id="design-btn-size">
              <Choice
                id="design-btn-size"
                value={design?.button?.size ?? 'md'}
                options={DESIGN_BUTTON_SIZES}
                titles={BUTTON_SIZE_TITLES}
                onChange={(v) => set('button', 'size', dflt(v, 'md'))}
              />
            </Field>
          </Group>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// Ширина шторки — одним числом на два места: класс w-80 у панели и отступ оболочки.
// 20rem = w-80; расхождение этих двух чисел означало бы щель или нахлёст.
const DRAWER_WIDTH = '20rem'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_8.5rem] items-center gap-2">
      <Label htmlFor={id} className="text-muted-foreground font-normal">
        {label}
      </Label>
      {children}
    </div>
  )
}

// Choice — один дропдаун на все восемь перечислимых настроек. Отдельный компонент, а
// не восемь копий Select: форма у них одна, и копии разъехались бы при первой правке.
function Choice({
  id,
  value,
  options,
  titles,
  onChange,
  disabled,
}: {
  id: string
  value: string
  options: readonly string[]
  titles: Record<string, string>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {titles[o]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// NumberRow — число с диапазоном. Пустое поле означает «по умолчанию», а не ноль:
// стереть значение автор вправе, и это не то же самое, что поставить 0 (у скругления
// ноль — осмысленный выбор, прямые углы).
//
// ЧЕРНОВИК ОБЯЗАТЕЛЕН, И ЭТО НЕ ПЕРЕСТРАХОВКА. Первая редакция просто не пускала в
// стор значение вне диапазона — и поле стало непригодным для клавиатуры: при
// минимуме 14 набор «1» откатывался к прежнему значению, до «14» дойти было нельзя
// в принципе, Backspace из «16» тоже возвращал «16». Причина в том, что input
// контролируемый: раз состояние не изменилось, React восстанавливает DOM к
// отрендеренному. Поэтому набранный текст живёт здесь, а в стор уходит только
// готовое число — тот же приём, что у поля hex в ColorPicker.
function NumberRow({
  id,
  value,
  fallback,
  min,
  max,
  onChange,
}: {
  id: string
  value: number | undefined
  fallback: number
  min: number
  max: number
  onChange: (value: number | undefined) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // Значение из стора сильнее черновика, когда меняется мимо поля (undo, загрузка
  // формы): сверка в рендере, а не эффектом — тот дал бы лишний каскадный рендер
  // (react-hooks/set-state-in-effect), приём взят у FormSettings.
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setDraft(null)
  }

  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft ?? (value === undefined ? '' : String(value))}
      placeholder={String(fallback)}
      className="h-8"
      onChange={(e) => {
        const raw = e.currentTarget.value
        setDraft(raw)
        if (raw === '') {
          onChange(undefined)
          return
        }
        const n = Number(raw)
        // Вне диапазона в стор не уходит: контракт его отвергает (422), и автосейв
        // краснел бы прямо во время набора. В поле при этом остаётся набранное.
        if (!Number.isInteger(n) || n < min || n > max) return
        onChange(n)
      }}
      // По уходу фокуса черновик снимается: недобранное «1» не должно остаться
      // висеть в поле, показывая не то, что в документе.
      onBlur={() => setDraft(null)}
    />
  )
}

function ColorRow({
  title,
  value,
  onChange,
  onRemove,
}: {
  title: string
  value: string | undefined
  onChange: (hex: string) => void
  onRemove: () => void
}) {
  return (
    <div className="grid grid-cols-[1fr_8.5rem] items-center gap-2">
      <span className="text-muted-foreground text-sm">{title}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="border-input hover:bg-accent flex h-8 items-center gap-2 rounded-md border px-2 text-sm"
          >
            <span
              className="size-4 shrink-0 rounded-sm border"
              // Незаданный цвет показывается шашечками, а не белым квадратом: белый
              // читался бы как выбранный белый, хотя автор не выбирал ничего.
              style={
                value
                  ? { background: value }
                  : {
                      backgroundImage:
                        'linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)',
                      backgroundSize: '6px 6px',
                      backgroundPosition: '0 0,3px 3px',
                    }
              }
            />
            <span className="truncate">{value ?? 'по теме'}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64">
          <ColorPicker
            initial={value ?? '#3d3d3d'}
            swatches={SWATCHES}
            removeLabel="Вернуть цвет темы"
            onChange={onChange}
            onRemove={onRemove}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground flex gap-2 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

// Склонение после числа: русский требует трёх форм — 1 кусок, 2 куска, 5 кусков.
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

// Подписи — здесь, а не в @entities: список значений это контракт (его сверяет
// паритет-тест с Go), а перевод на человеческий — дело интерфейса.
const THEME_TITLES: Record<string, string> = { light: 'Светлая', dark: 'Тёмная' }
const WIDTH_TITLES: Record<string, string> = {
  narrow: 'Узкая',
  normal: 'Обычная',
  wide: 'Широкая',
}
const DENSITY_TITLES: Record<string, string> = {
  compact: 'Плотно',
  normal: 'Обычно',
  roomy: 'Просторно',
}
const ALIGN_TITLES: Record<string, string> = { left: 'Слева', center: 'По центру' }
const OUTLINE_TITLES: Record<string, string> = {
  shadow: 'Тень',
  border: 'Рамка',
  none: 'Без контура',
}
const BUTTON_VARIANT_TITLES: Record<string, string> = { solid: 'Заливка', outline: 'Контур' }
const BUTTON_WIDTH_TITLES: Record<string, string> = { auto: 'По тексту', full: 'Во всю ширину' }
const BUTTON_SIZE_TITLES: Record<string, string> = {
  sm: 'Мелкая',
  md: 'Обычная',
  lg: 'Крупная',
}
