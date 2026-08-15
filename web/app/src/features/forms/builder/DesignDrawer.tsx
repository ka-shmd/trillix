import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Lock, TriangleAlert } from 'lucide-react'

import {
  CSS_MARKUP_ESCAPE,
  DESIGN_ALIGNS,
  MAX_CUSTOM_CSS_LEN,
  DESIGN_BUTTON_SIZES,
  DESIGN_BUTTON_VARIANTS,
  DESIGN_BUTTON_WIDTHS,
  DESIGN_DENSITIES,
  DESIGN_FONTS,
  DESIGN_FONT_DEFAULT,
  DESIGN_OUTLINES,
  MAX_FONT_SIZE,
  MAX_COLUMN,
  MAX_RADIUS,
  MIN_COLUMN,
  MIN_FONT_SIZE,
  MIN_RADIUS,
} from '@entities/formSchema'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

import { useFeatureAllowed } from '../../plan/useFeature'

import { ColorPicker } from './ColorPicker'
import { PALETTE_FIELDS, patch, patchTop, SWATCHES } from './designEdit'
import { currentTheme, hasCustomFields, resetToTheme, withTheme } from './designTheme'
import { lowContrast } from './designWarnings'
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

  // Обе тонкости выбора темы («светлая = отсутствие ключа», «пустой остаток =
  // undefined») живут в designTheme.ts отдельным модулем — ровно чтобы их можно было
  // проверить тестом: Radix Select в happy-dom не открывается вовсе (STATUS.md), и
  // через разметку эта логика непокрываема. По той же причине отдельно живут patch()
  // и обе проверки-предупреждения.
  const theme = currentTheme(design)
  const contrast = lowContrast(design)

  // ГЕЙТЫ ТАРИФА ПОКАЗЫВАЮТСЯ, НО НИЧЕГО НЕ ЗАПИРАЮТ (спека §9.3). Черновик со
  // своими цветами обязан сохраняться на любом тарифе — стена стоит на публикации,
  // и она на бэке. Панель, отключающая контролы, отняла бы у автора возможность
  // посмотреть, за что он платит, — то есть сам повод заплатить.
  const canCustomize = useFeatureAllowed('form_design_custom')
  const canRemoveBadge = useFeatureAllowed('form_branding')
  const canUseCSS = useFeatureAllowed('form_custom_css')

  // Тема, которую автор выбрал, но которая СОТРЁТ его настройки: держим её здесь,
  // пока он не подтвердит. null — диалога нет.
  const [pendingTheme, setPendingTheme] = useState<'light' | 'dark' | null>(null)

  // Переход на готовую тему сбрасывает всё своё — поэтому спрашиваем. Если сбрасывать
  // нечего, спрашивать не о чем: диалог на пустом месте приучает жать «да» не глядя,
  // и в тот раз, когда он про настоящую потерю, его тоже прожмут не читая.
  const chooseTheme = (next: string) => {
    if (next === 'custom') return
    const base = next as 'light' | 'dark'
    if (hasCustomFields(design)) setPendingTheme(base)
    else setDesign(withTheme(design, base))
  }

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

  // Набор CSS — непрерывный жест, как подбор цвета: без ключа коалесинга каждая
  // буква становилась бы шагом отмены и вытесняла из истории работу над формой
  // (ровно тот дефект, который ревью нашло у выборщика цвета в слайсе 4).
  //
  // ОТВЕРГНУТОЕ ЗНАЧЕНИЕ ДО СТОРА НЕ ДОЕЗЖАЕТ — тот же приём, что у имени блока
  // (ClassSetting). Валидатор не принимает `</` (единственная точка, где авторский
  // текст соседствует с разметкой по существу), и вход бытовой: сниппет копируют
  // вместе с обёрткой `<style>…</style>`. Без задержки здесь автосейв ловил бы 422 и
  // показывал автору общий индикатор ошибки, из которого причины не видно вовсе.
  //
  // Драфт живёт РОВНО ПОКА ТЕКСТ НЕВАЛИДЕН и снимается на первом же годном значении:
  // иначе он навсегда заслонил бы стор и отменил бы undo для этого поля.
  const [cssDraft, setCssDraft] = useState<string | null>(null)
  const cssValue = cssDraft ?? design?.css ?? ''
  const cssInvalid = cssValue.includes(CSS_MARKUP_ESCAPE)
  const setCss = (value: string) => {
    if (value.includes(CSS_MARKUP_ESCAPE)) {
      setCssDraft(value)
      return
    }
    setCssDraft(null)
    setDesign(patchTop(design, 'css', value.trim() === '' ? undefined : value), 'design:css')
  }

  // «Показывать» = отсутствие ключа, «не показывать» = false. Второго
  // представления у первого состояния нет — этого же требует валидатор.
  const patchBranding = (show: boolean) =>
    setDesign(patchTop(design, 'branding', show ? undefined : false))

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
        className="w-104 gap-0 overflow-y-auto sm:max-w-104 data-[state=closed]:duration-300 data-[state=open]:duration-300"
        aria-label="Оформление формы"
      >
        <SheetHeader>
          <SheetTitle>Оформление</SheetTitle>
          <SheetDescription>Как форма выглядит у респондента.</SheetDescription>
        </SheetHeader>

        <div className="grid gap-5 px-4 pb-10">
          {!canCustomize && (
            <p className="text-muted-foreground bg-muted/50 flex gap-2 rounded-md p-3 text-sm">
              <Lock className="mt-0.5 size-4 shrink-0" />
              <span>
                Своё оформление — на платном тарифе. Настроить и посмотреть можно уже
                сейчас, черновик сохранится; опубликовать форму с ним не получится.{' '}
                <Link to="/settings/plan" className="underline underline-offset-2">
                  Тариф
                </Link>
              </span>
            </p>
          )}

          {/* Три темы в панели, но ДВЕ в схеме: «Пользовательская» — не значение, а
              вывод из наличия своих настроек (designTheme.ts). Поэтому она и
              включается сама при первой же правке цвета, и не выбирается руками:
              выбрать «мои настройки», не сделав ни одной, нечего. */}
          <Field label="Тема" id="design-theme">
            <Choice
              id="design-theme"
              value={theme}
              // «Пользовательская» ПОЯВЛЯЕТСЯ В СПИСКЕ, только когда она и есть
              // текущая (решение владельца 2026-08-10). Держать её выключенной в
              // списке всегда нельзя — это «выбор», которого нет: выбрать «мои
              // настройки», не сделав ни одной, нечего, а пункт создаёт впечатление,
              // что можно. Пока она текущая, убирать её тоже нельзя: она объясняет,
              // ПОЧЕМУ дропдаун показывает не «Светлую».
              options={theme === 'custom' ? THEME_OPTIONS : THEME_OPTIONS_BASE}
              titles={THEME_TITLES}
              disabledOptions={['custom']}
              onChange={chooseTheme}
            />
          </Field>

          <Separator />

          <Group title="Цвета" locked={!canCustomize}>
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
              <Wide>
                <Warning>
                Контраст текста к фону — {contrast.toFixed(1)}:1, ниже рекомендованных 4,5:1.
                  Такой текст трудно читать на телефоне и при ярком свете.
                </Warning>
              </Wide>
            )}
          </Group>

          <Separator />

          <Group title="Лэйаут" locked={!canCustomize}>
            {/* Шрифт ОДИН на всю форму (решение владельца 2026-08-09): раздельные
                семейства для текста и заголовков были заведены и убраны — на форме
                из десяти строк это читается не как брендирование, а как небрежность. */}
            <Field label="Шрифт" id="design-font">
              <Choice
                id="design-font"
                value={design?.font ?? DESIGN_FONT_DEFAULT}
                options={DESIGN_FONTS}
                titles={FONT_TITLES}
                onChange={(v) => setDesign(patchTop(design, 'font', dflt(v, DESIGN_FONT_DEFAULT)))}
              />
            </Field>
            {/* Ширина — числом, а не выбором из трёх: три варианта покрывают три
                макета из бесконечности (решение владельца 2026-08-09). */}
            <Field label="Ширина, px" id="design-width">
              <NumberRow
                id="design-width"
                value={design?.layout?.width}
                fallback={700}
                min={MIN_COLUMN}
                max={MAX_COLUMN}
                onChange={(n) => set('layout', 'width', n)}
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

          {/* «Кнопки», а не «кнопка отправки»: размер, поля и радиус управляют всеми
              кнопками шага, включая «Назад» и «Далее» многостраничной формы (решение
              владельца 2026-08-09). Вид остаётся только у главного действия: «Назад»
              контурная всегда — уравнять «вернуться» с «отправить» нельзя. */}
          <Group title="Кнопки" locked={!canCustomize}>
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

          <Separator />

          {/* СВОЙ CSS — последней секцией, и это не про важность: остальные настройки
              покрывают то, что должно быть под рукой, а сюда спускаются, когда их не
              хватило. Поле голое, без подсветки и автодополнения: редактор кода в
              шторке шириной в 26rem — это обещание удобства, которого мы не дадим,
              а CSS сюда приносят готовым. */}
          <Group title="Свой CSS" locked={!canUseCSS}>
            <Wide>
              <Textarea
                id="design-css"
                value={cssValue}
                onChange={(e) => setCss(e.target.value)}
                maxLength={MAX_CUSTOM_CSS_LEN}
                spellCheck={false}
                rows={8}
                className="font-mono text-xs"
                placeholder={'.my-block .rf-input {\n  border-radius: 0;\n}'}
              />
            </Wide>
            {cssInvalid && (
              <Wide>
                <p className="text-muted-foreground text-xs">
                  Последовательность <code>&lt;/</code> не допускается — уберите теги{' '}
                  <code>&lt;style&gt;</code>, оставьте только правила. Пока она есть,
                  CSS не сохраняется.
                </p>
              </Wide>
            )}
            <Wide>
              <p className="text-muted-foreground text-xs">
                Правила применяются к форме у респондента и в превью — на полотно
                редактора они не действуют. Пометьте блок своим именем в его настройках
                и обращайтесь к нему как к классу.
              </p>
            </Wide>
            {design?.css && !canUseCSS && (
              <Wide>
                <Warning>
                  На бесплатном тарифе форму с этим CSS не опубликовать. Черновик
                  сохранится.
                </Warning>
              </Wide>
            )}
          </Group>

          <Separator />

          {/* БЕЙДЖ — переключатель, а не дропдаун: состояний два, и «показывать» это
              отсутствие ключа в схеме. Гейт у него ДРУГОЙ природы, чем у остального
              оформления: публикацию он не держит (снять намерение можно на любом
              тарифе), а срабатывает при отдаче формы — поэтому на бесплатном тарифе
              выключенный переключатель честно предупреждает, что бейдж всё равно
              останется. */}
          <Group title="Бейдж" locked={!canRemoveBadge}>
            <Wide>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Показывать «Сделано в Trillix»</span>
                <Switch
                  checked={design?.branding !== false}
                  onCheckedChange={(on) => patchBranding(on)}
                />
              </label>
            </Wide>
            {design?.branding === false && !canRemoveBadge && (
              <Wide>
                <Warning>
                  На бесплатном тарифе бейдж остаётся на форме. Настройка сохранится и
                  сработает сразу после перехода на платный.
                </Warning>
              </Wide>
            )}
          </Group>
        </div>
      </SheetContent>

      {/* Предупреждение перед сбросом. Диалог, а не «отменить» тостом после: правки
          оформления копятся долго (семь цветов, шрифт, лэйаут), и восстановить их по
          памяти дороже, чем один раз прочитать вопрос. */}
      <AlertDialog open={pendingTheme !== null} onOpenChange={(o) => !o && setPendingTheme(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Вернуться к теме «{pendingTheme ? THEME_TITLES[pendingTheme] : ''}»?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Готовая тема заменит оформление целиком: свои цвета, шрифт, лэйаут, поля и
              кнопки будут сброшены. Отменить это можно будет через Ctrl+Z.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingTheme) setDesign(resetToTheme(pendingTheme, design))
                setPendingTheme(null)
              }}
            >
              Сбросить оформление
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}

// Ширина шторки — одним числом на два места: класс w-80 у панели и отступ оболочки.
// 20rem = w-80; расхождение этих двух чисел означало бы щель или нахлёст.
const DRAWER_WIDTH = '26rem'

// Две колонки (решение владельца 2026-08-09): контролов в панели полтора десятка, и
// в один столбец они уезжают за пределы экрана — до кнопки приходилось скроллить,
// не видя формы, ради которой панель и открыта. Заголовок группы занимает обе.
// locked — метка «Pro» у заголовка группы. Именно метка, а не disabled у контролов:
// настройка остаётся доступной (черновик сохранится на любом тарифе), закрыт только
// результат — публикация или отдача. Показывает панель, отказывает бэк (инвариант 3).
//
// Слово, а не один замок (решение владельца 2026-08-10): замок сообщает «нельзя», но
// не сообщает ЧТО с этим делать, и на секции, где половина настроек бесплатна, читался
// как поломка. «Pro» называет тариф, на котором это работает.
function Group({
  title,
  children,
  locked = false,
}: {
  title: string
  children: ReactNode
  locked?: boolean
}) {
  return (
    <section className="grid grid-cols-2 gap-x-3 gap-y-3">
      <h3 className="col-span-2 flex items-center gap-1.5 text-sm font-medium">
        {title}
        {locked && <ProTag />}
      </h3>
      {children}
    </section>
  )
}

// ProTag — метка платной возможности. Ссылка, а не подпись: автор, увидевший её,
// должен иметь возможность узнать цену тем же жестом, каким заметил ограничение.
function ProTag() {
  return (
    <Link
      to="/settings/plan"
      className="text-muted-foreground border-border hover:text-foreground inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
    >
      <Lock className="size-3" aria-hidden="true" />
      Pro
    </Link>
  )
}

// Ячейка во всю ширину — для того, что в половину не влезает (предупреждения).
function Wide({ children }: { children: ReactNode }) {
  return <div className="col-span-2">{children}</div>
}

// Подпись НАД контролом, а не слева (решение владельца 2026-08-09): в колонке
// шириной в половину панели подпись сбоку отбирала у контрола больше места, чем
// занимала сама, и длинные названия («Приглушённый текст») переносились в две
// строки, разъезжаясь по высоте с соседями.
function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-muted-foreground text-xs font-normal">
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
  disabledOptions,
}: {
  id: string
  value: string
  options: readonly string[]
  titles: Record<string, string>
  onChange: (value: string) => void
  disabled?: boolean
  // Выключенные пункты, а не выкинутые из списка: «Пользовательская» обязана
  // оставаться видимой — она объясняет, ПОЧЕМУ дропдаун показывает не «Светлую».
  disabledOptions?: readonly string[]
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o} disabled={disabledOptions?.includes(o)}>
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
    <div className="grid gap-1">
      <span className="text-muted-foreground text-xs">{title}</span>
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

// Подписи — здесь, а не в @entities: список значений это контракт (его сверяет
// паритет-тест с Go), а перевод на человеческий — дело интерфейса.
const THEME_OPTIONS_BASE = ['light', 'dark'] as const
const THEME_OPTIONS = [...THEME_OPTIONS_BASE, 'custom'] as const
const THEME_TITLES: Record<string, string> = {
  light: 'Светлая',
  dark: 'Тёмная',
  custom: 'Пользовательская',
}
const DENSITY_TITLES: Record<string, string> = {
  compact: 'Плотно',
  normal: 'Обычно',
  roomy: 'Просторно',
}
const ALIGN_TITLES: Record<string, string> = { left: 'Слева', center: 'По центру' }
const FONT_TITLES: Record<string, string> = {
  system: 'Системный',
  inter: 'Inter',
  golos: 'Golos Text',
  manrope: 'Manrope',
  onest: 'Onest',
  montserrat: 'Montserrat',
  lora: 'Lora',
}
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
