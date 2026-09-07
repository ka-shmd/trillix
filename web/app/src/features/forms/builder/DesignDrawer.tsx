import { useState, type ReactNode } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToDot,
  ArrowRightToLine,
  MoveHorizontal,
  TriangleAlert,
} from 'lucide-react'

import {
  CSS_MARKUP_ESCAPE,
  isHexColor,
  MAX_CUSTOM_CSS_LEN,
  DESIGN_BUTTON_ALIGNS,
  DESIGN_BUTTON_WEIGHTS,
  DESIGN_BUTTON_WIDTHS,
  DESIGN_FONTS,
  DESIGN_FONT_DEFAULT,
  BUTTON_WIDTH_DEFAULT,
  MAX_FONT_SIZE,
  MAX_COLUMN,
  MAX_BORDER_WIDTH,
  MAX_BUTTON_FONT,
  MAX_BUTTON_HEIGHT,
  MAX_BUTTON_MARGIN_TOP,
  MAX_BUTTON_PADDING_X,
  MAX_BUTTON_RADIUS,
  MAX_BUTTON_WIDTH,
  MAX_MARGIN_BOTTOM,
  MAX_PADDING_X,
  MAX_FIELD_HEIGHT,
  MAX_FIELD_WIDTH,
  MIN_BORDER_WIDTH,
  MIN_BUTTON_FONT,
  MIN_BUTTON_HEIGHT,
  MIN_BUTTON_MARGIN_TOP,
  MIN_BUTTON_PADDING_X,
  MIN_BUTTON_RADIUS,
  MIN_BUTTON_WIDTH,
  MIN_MARGIN_BOTTOM,
  MIN_PADDING_X,
  MIN_FIELD_HEIGHT,
  MIN_FIELD_WIDTH,
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
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

import { useAppDrawerOffset } from '../../../shared/appDrawer'
import { CodeField } from '../../../shared/CodeField'
import { useFeatureAllowed } from '../../plan/useFeature'
import { ProTag } from '../../../shared/ProTag'

import { ColorPicker } from './ColorPicker'
import { CONTROL, CONTROL_BOX, CONTROL_SELECT, CONTROL_TABS, LABEL } from './designControl'
import { CoverRow, LogoRow } from './DesignChrome'
import { type FormIdSource } from './mediaUpload'
import {
  BORDER_PALETTE_FIELD,
  BUTTON_PALETTE_FIELDS,
  FIELD_PALETTE_FIELDS,
  PALETTE_FIELDS,
  patch,
  patchTop,
  SWATCHES,
} from './designEdit'
import { themeColor } from './designDefaults'
import {
  baseTheme,
  currentTheme,
  hasAdvancedFields,
  hasCustomFields,
  resetToTheme,
  withTheme,
} from './designTheme'
import { lowContrast } from './designWarnings'
import { NumberRow } from './NumberRow'
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
  formId,
  open,
  onOpenChange,
}: {
  // formId нужен строкам хрома: загрузка картинки логотипа и обложки идёт в медиа
  // формы, а не воркспейса (тот же поток, что у картинки блока).
  formId: FormIdSource
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
  // База, у которой берётся цвет, которого автор не задавал: строка палитры
  // показывает не «по теме», а то, что форма рисует прямо сейчас.
  const base = baseTheme(design)
  const fieldFull = design?.controls?.fullWidth === true
  const btnWidth = design?.button?.width ?? 'auto'
  const contrast = lowContrast(design)

  // ГЕЙТЫ ТАРИФА ПОКАЗЫВАЮТСЯ, НО НИЧЕГО НЕ ЗАПИРАЮТ (спека §9.3). Черновик со
  // своими цветами обязан сохраняться на любом тарифе — стена стоит на публикации,
  // и она на бэке. Панель, отключающая контролы, отняла бы у автора возможность
  // посмотреть, за что он платит, — то есть сам повод заплатить.
  const canCustomize = useFeatureAllowed('form_design_custom')
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

  // Сдвиг оболочки под открытую шторку — общий хук на все шторки редактора
  // (`shared/appDrawer.ts`): ширина панели и отступ страницы там одним числом.
  useAppDrawerOffset(open)

  const set = (
    group: 'palette' | 'layout' | 'controls' | 'button',
    key: string,
    value: string | number | boolean | undefined,
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
        // aria-describedby={undefined} — у панели больше нет подзаголовка, а Radix
        // иначе пишет в консоль предупреждение об отсутствующем Description (тот же
        // гард, что у PreviewOverlay).
        aria-describedby={undefined}
      >
        <SheetHeader>
          <SheetTitle>Оформление</SheetTitle>
        </SheetHeader>

        <div className="grid gap-6 px-4 pb-6">
          {/* ОСНОВНЫЕ НАСТРОЙКИ — ПЕРВЫЙ РАЗДЕЛ, И ОН БЕЗ ЗАГОЛОВКА (решение
              владельца 2026-08-28). Заголовка нет намеренно: раздел стоит первым и
              сразу под подзаголовком шторки, а «Основное» над самой верхней группой
              называет то, что читатель и так видит по месту.

              Пять решений, с которых подбор вида начинается: тема, шрифт и три
              цвета — фон, текст, акцент. Остальные четыре цвета контракта панель не
              показывает вовсе (designEdit.ts), лэйаут, поля, кнопки и свой CSS
              лежат ниже разделителя.

              Метки Pro у раздела нет — вешать её не на что, заголовка нет. Про
              платность своего оформления сообщает плашка выше, она стоит вплотную. */}
          <Group>
            {/* Три темы в панели, но ДВЕ в схеме: «Пользовательская» — не значение, а
                вывод из наличия своих настроек (designTheme.ts). Поэтому она и
                включается сама при первой же правке цвета, и не выбирается руками:
                выбрать «мои настройки», не сделав ни одной, нечего. */}
            <Wide>
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
            </Wide>
            {/* Шрифт ОДИН на всю форму (решение владельца 2026-08-09): раздельные
                семейства для текста и заголовков были заведены и убраны — на форме
                из десяти строк это читается не как брендирование, а как небрежность. */}
            <Wide>
              <Field label="Шрифт" id="design-font">
                <Choice
                  id="design-font"
                  value={design?.font ?? DESIGN_FONT_DEFAULT}
                  options={DESIGN_FONTS}
                  titles={FONT_TITLES}
                  onChange={(v) =>
                    setDesign(patchTop(design, 'font', dflt(v, DESIGN_FONT_DEFAULT)))
                  }
                />
              </Field>
            </Wide>
            {/* Три цвета в две колонки: фон и текст рядом (их и сравнивают друг с
                другом), акцент под ними слева. */}
            {PALETTE_FIELDS.map(({ key, title }) => (
              <ColorRow
                key={key}
                id={`design-color-${key}`}
                title={title}
                value={design?.palette?.[key]}
                fromTheme={themeColor(base, key)}
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

          {/* ДОПОЛНИТЕЛЬНО — ОДИН РАЗДЕЛ НА ТРИ ГРУППЫ (решение владельца 2026-08-28).
              Лэйаут, поля и кнопки лежали ровно на том же уровне, что основные
              настройки, и панель читалась плоским списком из шести равнозначных
              секций — а они не равнозначны: первые пять решений задают вид формы,
              остальные его дотачивают. Заголовок над тремя группами эту разницу и
              называет, поэтому разделители между ними убраны: разделитель отделяет
              соседей, а тут соседи — части одного.

              Заголовок крупнее групповых (20/700 против 16/600) — иначе он встал бы с
              ними в один ряд, и вложенности было бы не видно. */}
          <section className="grid gap-6">
            {/* МЕТКА PRO — ОДНА НА ВЕСЬ РАЗДЕЛ, а не на каждую группу: платно тут
                всё (`form_design_custom` покрывает ширину, кегль, плотность,
                выравнивание, скругление, контур и кнопку — DesignPaidFeatures), и
                три метки подряд сообщали бы то же самое трижды. Заодно это чинит
                старое расхождение: «Поля» метки не носили, хотя гейт на бэке их
                считал платными ровно так же.

                СТОИТ ВСЕГДА, а не только у бесплатного тарифа: метка называет тариф,
                на котором раздел работает, — это свойство раздела, а не состояние
                читателя. Про читателя говорит предупреждение ниже, и говорит тогда,
                когда ему есть о чём. Метка, а не disabled у контролов, — см. Group. */}
            <div className="grid gap-2">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                Дополнительно
                <ProTag />
              </h2>
              {/* Предупреждение — только когда в разделе УЖЕ что-то задано: пока он
                  пуст, публикации ничего не мешает, и сказанное заранее было бы
                  предупреждением ни о чём. Метка рядом с заголовком к этому моменту
                  тариф уже назвала. */}
              {!canCustomize && hasAdvancedFields(design) && (
                <Warning>
                  Эти настройки видно в редакторе и в просмотре, но опубликовать форму с ними не
                  получится — они на платном тарифе.
                </Warning>
              )}
            </div>

            {/* ПЛОТНОСТЬ И ВЫРАВНИВАНИЕ ИЗ ПАНЕЛИ УБРАНЫ (решение владельца
                2026-08-29). Плотность — общий множитель всех интервалов ритма, и
                рядом с прямыми «отступ снизу» и «отступ по бокам» она стала вторым
                способом двигать те же расстояния; выравнивание по центру задавало
                форму, к которой прочие настройки секции не относятся вовсе.

                `layout.density` и `layout.align` остались в схеме и рисуются:
                документ с ними принимается как раньше, недоступна только правка
                руками — тот же приём, что у controls.outline и button.variant. */}
            <Group title="Лэйаут">
              {/* Ширина — числом, а не выбором из трёх: три варианта покрывают три
                макета из бесконечности (решение владельца 2026-08-09). */}
              <Field label="Ширина, px" id="design-width">
                <NumberRow
                  className={CONTROL_BOX}
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
                  className={CONTROL_BOX}
                  id="design-font-size"
                  value={design?.layout?.fontSize}
                  fallback={16}
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  onChange={(n) => set('layout', 'fontSize', n)}
                />
              </Field>
              {/* Логотип и обложка — в «Лэйауте» (решение владельца 2026-08-16): их
                размеры это геометрия страницы, и подбираются они рядом с шириной
                колонки и кеглем. Метка Pro у секции их НЕ касается — сам хром
                бесплатен и гейта не получил; платно всё остальное в секции. */}
              <LogoRow formId={formId} />
              <CoverRow formId={formId} />
            </Group>

            <Group title="Поля">
              {/* ШИРИНА ПОЛЯ — ПЕРЕКЛЮЧАТЕЛЬ И ЧИСЛО В ОДНОЙ СТРОКЕ (решение владельца
                  2026-08-29). Это одна настройка в двух состояниях, а не две: «полная»
                  и «320px» отвечают на один вопрос, и разведённые по двум подписям они
                  читались бы как независимые.

                  Вкладки — тот же контрол, что выбирает вид вставки на экране
                  «Встроить» (ModeChoice): выбор из двух-трёх взаимоисключающих
                  состояний, оба показываются целиком, и дропдаун прятал бы половину за
                  нажатием. Внутри — значки, а не подписи: «Фиксированная ширина» в
                  колонку шириной в половину панели не влезает, а сокращённая до «Фикс.»
                  не объясняет ничего; полное название приезжает подсказкой.

                  Настройка правит ПОТОЛОК (--rf-input-max), а не ширину: поле всегда
                  занимает 100% доступного, потолок лишь не даёт ему разъехаться на всю
                  колонку. Поэтому «полная ширина» здесь — обычное значение «100%», без
                  класса (в отличие от колонки страницы, где число стоит внутри calc). */}
              <Field label="Ширина" id="design-field-width" group>
                <div className="flex items-center gap-2">
                  <Tabs
                    value={fieldFull ? 'full' : 'fixed'}
                    // Пустое значение Radix здесь не отдаёт (в отличие от ToggleGroup):
                    // у вкладок всегда ровно одна активная, что для ширины и верно —
                    // поле либо той ширины, либо этой.
                    onValueChange={(v) =>
                      set('controls', 'fullWidth', v === 'full' ? true : undefined)
                    }
                    className="shrink-0"
                  >
                    <TabsList aria-labelledby="design-field-width-label" className={CONTROL_TABS}>
                      {FIELD_WIDTH_MODES.map((mode) => (
                        // ПОДСКАЗКА ВНУТРИ ВКЛАДКИ, А НЕ ВОКРУГ НЕЁ. `TooltipTrigger
                        // asChild` подмешивает в дочерний элемент собственный
                        // `data-state` («closed»/«delayed-open»), и тот перебивает
                        // `data-state="active"` вкладки — подсветка активной не
                        // срабатывает вовсе. Два радиксовых контрола на одном узле не
                        // уживаются: атрибут состояния у них общий по имени.
                        <TabsTrigger key={mode} value={mode} aria-label={FIELD_WIDTH_TITLES[mode]}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="flex items-center">
                                {mode === 'full' ? (
                                  <MoveHorizontal className="size-4" />
                                ) : (
                                  <ArrowDownToDot className="size-4" />
                                )}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{FIELD_WIDTH_TITLES[mode]}</TooltipContent>
                          </Tooltip>
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  {fieldFull ? (
                    // Запертое «100%» вместо спрятанного поля: пустое место на месте
                    // настройки читается как «её тут нет», а исчезающий контрол дёргает
                    // соседей на каждое переключение. Показанное честно — ровно столько
                    // поле и займёт.
                    //
                    // ЧИСЛО В ДОКУМЕНТЕ НЕ ТРОГАЕТСЯ: автор переключается туда-обратно,
                    // сравнивая, и подобранные 480px обязаны его дождаться.
                    <Input value="100%" disabled readOnly className={`min-w-0 ${CONTROL_BOX}`} />
                  ) : (
                    <NumberRow
                      className={CONTROL_BOX}
                      id="design-field-width"
                      value={design?.controls?.width}
                      // Зеркалит --rf-input-max в fields.css: незаданный потолок панель
                      // показывает тем же числом, которое рисует полотно.
                      fallback={320}
                      min={MIN_FIELD_WIDTH}
                      max={MAX_FIELD_WIDTH}
                      onChange={(n) => set('controls', 'width', n)}
                    />
                  )}
                </div>
              </Field>
              {/* Высота — рядом с шириной, а не под скруглением: это вторая половина
                  одного вопроса «какого размера поле», и разведённые по разным строкам
                  они читались бы как настройки разных вещей. За ней едет и кнопка:
                  --rf-submit-h выводится из той же переменной, пока автор не задал
                  размер кнопки явно. */}
              <Field label="Высота" id="design-field-height">
                <NumberRow
                  className={CONTROL_BOX}
                  id="design-field-height"
                  value={design?.controls?.height}
                  // Зеркалит --rf-control-h в fields.css: незаданную высоту панель
                  // показывает тем же числом, которое рисует полотно.
                  fallback={36}
                  min={MIN_FIELD_HEIGHT}
                  max={MAX_FIELD_HEIGHT}
                  onChange={(n) => set('controls', 'height', n)}
                />
              </Field>
              {/* ЦВЕТА ПОЛЯ — ЗДЕСЬ, А НЕ В ВЕРХНЕМ РАЗДЕЛЕ (решение владельца
                  2026-08-29): наверху три решения о виде формы целиком, а это свойства
                  одного элемента, и подбирают их рядом с его размером и контуром.
                  Строка та же, что у основных цветов, — вместе с показом цвета темы,
                  когда автор своего не задавал. */}
              {FIELD_PALETTE_FIELDS.map(({ key, title }) => (
                <ColorRow
                  key={key}
                  id={`design-color-${key}`}
                  title={title}
                  value={design?.palette?.[key]}
                  fromTheme={themeColor(base, key)}
                  onChange={(hex) => set('palette', key, hex, `design:palette:${key}`)}
                  onRemove={() => set('palette', key, undefined)}
                />
              ))}
              {/* КРАЙ КОНТРОЛА — ТРИ НАСТРОЙКИ ОДНОЙ СТРОКОЙ (решение владельца
                  2026-08-29): цвет, толщина и радиус описывают одну рамку, и
                  разведённые по строкам они читались бы как настройки разных вещей.
                  Своя сетка в три колонки — в общей двухколоночной третьей ячейки нет,
                  а числа тут короткие и в треть строки помещаются.

                  ДРОПДАУН «КОНТУР» ОТСЮДА УБРАН (решение владельца 2026-08-29):
                  толщина 0 и есть «без контура», а выбор способа рисования рядом с
                  явными цветом и толщиной читался вторым ответом на тот же вопрос.
                  Поле `controls.outline` в схеме осталось — документ с ним принимается
                  и рисуется как прежде, но задать его руками больше нельзя (тот же
                  приём, что у скрытых цветов палитры). */}
              <Wide>
                {/* Четыре колонки, а не поровну: цвету нужна вся строка «#e0e0df», числам
                    хватает трёх знаков, чекбоксу — слова. `items-end` равняет их по
                    нижнему краю: у трёх настроек над контролом стоит подпись, у
                    чекбокса её нет, и по верху они разъехались бы. */}
                <div className="grid grid-cols-[1.4fr_1fr_1fr_auto] items-end gap-3">
                  <ColorRow
                    id={`design-color-${BORDER_PALETTE_FIELD.key}`}
                    title={BORDER_PALETTE_FIELD.title}
                    value={design?.palette?.[BORDER_PALETTE_FIELD.key]}
                    fromTheme={themeColor(base, BORDER_PALETTE_FIELD.key)}
                    onChange={(hex) =>
                      set('palette', BORDER_PALETTE_FIELD.key, hex, 'design:palette:border')
                    }
                    onRemove={() => set('palette', BORDER_PALETTE_FIELD.key, undefined)}
                  />
                  <Field label="Ширина" id="design-border-width">
                    <NumberRow
                      className={CONTROL_BOX}
                      id="design-border-width"
                      value={design?.controls?.borderWidth}
                      // Зеркалит --rf-ring-w в fields.css.
                      fallback={1}
                      min={MIN_BORDER_WIDTH}
                      max={MAX_BORDER_WIDTH}
                      onChange={(n) => set('controls', 'borderWidth', n)}
                    />
                  </Field>
                  <Field label="Радиус" id="design-radius">
                    <NumberRow
                      className={CONTROL_BOX}
                      id="design-radius"
                      value={design?.controls?.radius}
                      // Зеркалит --rf-radius в fields.css: незаданное скругление панель
                      // показывает тем же числом, которое рисует полотно.
                      fallback={6}
                      min={MIN_RADIUS}
                      max={MAX_RADIUS}
                      onChange={(n) => set('controls', 'radius', n)}
                    />
                  </Field>
                  {/* ТЕНЬ — ЧЕКБОКС, а не третий пункт бывшего «Контура» (решение
                      владельца 2026-08-29): это не другой способ рисовать край, а слой,
                      который либо есть, либо нет. В документ попадает только СНЯТИЕ
                      (`shadow: false`) — тень остаётся дефолтом, а дефолт хранится
                      отсутствием ключа.

                      Гасятся оба слоя разом (класс rf-shadow-off): тень поля это ближний
                      блик под верхней кромкой плюс мягкое рассеивание вниз, и снятая
                      наполовину она читается не как решение, а как брак. */}
                  <Field label="Тень" id="design-shadow">
                    {/* Коробка ростом с соседние поля: сам чекбокс 16px, и без неё
                        подпись над ним встала бы ниже соседних подписей. Ширину этой
                        колонке задаёт подпись «Тень», а не чекбокс, поэтому он
                        центрируется под ней: прижатый влево, он стоял бы не под своим
                        словом. */}
                    <div className={`flex items-center justify-center ${CONTROL}`}>
                      <Checkbox
                        id="design-shadow"
                        checked={design?.controls?.shadow !== false}
                        onCheckedChange={(on) => set('controls', 'shadow', on ? undefined : false)}
                      />
                    </div>
                  </Field>
                </div>
              </Wide>
              {/* ВОЗДУХ ВОКРУГ ПОЛЯ — последняя строка секции: внутренние боковые поля
                  контрола и расстояние до следующего вопроса. Обе про воздух, поэтому
                  стоят рядом, и обе допускают ноль — поле без боковых полей и вопросы
                  вплотную это крайние, но осмысленные виды.

                  «Отступ снизу» — воздух ПЕРЕД следующим вопросом (--rf-space-q): для
                  автора это отступ снизу текущего, для CSS — margin-top соседа.
                  Ступени заголовков за ним не едут: правится расстояние между
                  вопросами, а не вся вертикальная шкала формы. */}
              <Field label="Отступ снизу" id="design-margin-bottom">
                <NumberRow
                  className={CONTROL_BOX}
                  id="design-margin-bottom"
                  value={design?.controls?.marginBottom}
                  // Зеркалит --rf-space-q в fields.css.
                  fallback={24}
                  min={MIN_MARGIN_BOTTOM}
                  max={MAX_MARGIN_BOTTOM}
                  onChange={(n) => set('controls', 'marginBottom', n)}
                />
              </Field>
              <Field label="Отступ по бокам" id="design-padding-x">
                <NumberRow
                  className={CONTROL_BOX}
                  id="design-padding-x"
                  value={design?.controls?.paddingX}
                  // Зеркалит --rf-input-px в fields.css.
                  fallback={10}
                  min={MIN_PADDING_X}
                  max={MAX_PADDING_X}
                  onChange={(n) => set('controls', 'paddingX', n)}
                />
              </Field>
            </Group>

            {/* ВИД И РАЗМЕР ИЗ ПАНЕЛИ УБРАНЫ (решение владельца 2026-08-29). Кнопка
              теперь только заливкой: контурная была ВТОРЫМ способом сказать то же,
              что уже говорят свои цвет фона и цвет текста, — с прозрачным фоном и
              цветным контуром. Готовый размер (мелкая/обычная/крупная) тем же
              образом дублировал высоту и кегль, заданные числами выше.

              Поля `button.variant` и `button.size` остались в схеме и по-прежнему
              рисуются: документ с ними принимается как раньше, недоступна только
              правка руками — тот же приём, что у controls.outline и цвета muted. */}
            {/* «Кнопки», а не «кнопка отправки»: размер, поля и радиус управляют всеми
              кнопками шага, включая «Далее» многостраничной формы (решение владельца
              2026-08-09). Кнопка «Назад», ради которой множественное число и заводилось,
              снята вместе с ходом назад (2026-08-22) — правило осталось: у страницы
              бывает не одна кнопка, и все они одного размера. */}
            <Group title="Кнопки">
              {/* ШИРИНА — ПЕРВОЙ СТРОКОЙ И ВКЛАДКАМИ (решение владельца 2026-08-29):
                  режимов три, и они взаимоисключающие — дропдаун прятал бы два из трёх
                  за нажатием. Подписи здесь остаются словами, а не значками: они
                  короткие, строка своя, и рисовать «по тексту» пиктограммой значило бы
                  заводить словарь там, где хватает слова.

                  Строкой во всю ширину, а не половиной: три вкладки в колонку шириной
                  в половину панели не помещаются. */}
              {/* Ширина и высота — ОДНОЙ строкой: это размер кнопки, один вопрос в двух
                  числах. Ширина забирает остаток строки (у неё ещё три вкладки),
                  высоте хватает узкой колонки. */}
              <Wide>
                <div className="flex items-end gap-4">
                  <Field label="Ширина" id="design-btn-width" group className="flex-1">
                    <div className="flex items-center gap-2">
                      <Tabs
                        value={btnWidth}
                        onValueChange={(v) => set('button', 'width', dflt(v, 'auto'))}
                        className="shrink-0"
                      >
                        <TabsList aria-labelledby="design-btn-width-label" className={CONTROL_TABS}>
                          {DESIGN_BUTTON_WIDTHS.map((mode) => (
                            <TabsTrigger
                              key={mode}
                              value={mode}
                              aria-label={BUTTON_WIDTH_TITLES[mode]}
                            >
                              {/* Подсказка ВНУТРИ вкладки: `TooltipTrigger asChild` на
                                самой вкладке подмешал бы свой `data-state`, и активная
                                перестала бы подсвечиваться (см. ширину поля выше). */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="flex items-center">
                                    {BUTTON_WIDTH_ICONS[mode]}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>{BUTTON_WIDTH_TITLES[mode]}</TooltipContent>
                              </Tooltip>
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </Tabs>
                      {btnWidth === 'fixed' ? (
                        <NumberRow
                          className={CONTROL_BOX}
                          id="design-btn-width"
                          value={design?.button?.widthPx}
                          // Зеркалит BUTTON_WIDTH_DEFAULT: столько кнопка и займёт, пока
                          // автор своего числа не задал.
                          fallback={BUTTON_WIDTH_DEFAULT}
                          min={MIN_BUTTON_WIDTH}
                          max={MAX_BUTTON_WIDTH}
                          onChange={(n) => set('button', 'widthPx', n)}
                        />
                      ) : (
                        // Запертое поле вместо спрятанного — то же, что у ширины поля:
                        // пустое место на месте настройки читается как «её тут нет», а
                        // исчезающий контрол дёргает соседей на каждое переключение.
                        // Показанное честно: столько кнопка и займёт.
                        <Input
                          // «авто», а не «по тексту»: в запертом поле стоит ЗНАЧЕНИЕ, а
                          // «по тексту» — название режима, оно уже сказано вкладкой и её
                          // подсказкой.
                          value={btnWidth === 'full' ? '100%' : 'авто'}
                          disabled
                          readOnly
                          className={`min-w-0 ${CONTROL_BOX}`}
                        />
                      )}
                    </div>
                  </Field>
                  <Field label="Высота" id="design-btn-height" className="w-20 shrink-0">
                    <NumberRow
                      className={CONTROL_BOX}
                      id="design-btn-height"
                      value={design?.button?.height}
                      // Зеркалит --rf-submit-h: незаданная высота у кнопки та же, что у
                      // поля (--rf-control-h-base), пока автор не выбрал готовый размер.
                      fallback={36}
                      min={MIN_BUTTON_HEIGHT}
                      max={MAX_BUTTON_HEIGHT}
                      onChange={(n) => set('button', 'height', n)}
                    />
                  </Field>
                </div>
              </Wide>
              {/* ПОЛОЖЕНИЕ, КЕГЛЬ И СКРУГЛЕНИЕ — одной строкой: три штриха к уже
                  заданному размеру кнопки. Положение вкладками со значками, как ширина
                  выше; у него ТРИ значения, а не два, — кнопка стоит в своём ряду, где
                  есть и правый край (у выравнивания текста формы правого варианта нет
                  и не будет: правый текст читается как брак вёрстки).

                  Растянутой кнопке положение неприменимо — двигать нечего, поэтому
                  вкладки гаснут целиком. */}
              <Wide>
                <div className="flex items-end gap-4">
                  <Field label="Положение" id="design-btn-align" group className="shrink-0">
                    <Tabs
                      value={design?.button?.align ?? 'left'}
                      onValueChange={(v) => set('button', 'align', dflt(v, 'left'))}
                    >
                      <TabsList
                        aria-labelledby="design-btn-align-label"
                        className={CONTROL_TABS}
                        // Radix у выключенного списка гасит и вкладки: клик по ним
                        // ничего не делает, фокус их обходит.
                        aria-disabled={design?.button?.width === 'full'}
                      >
                        {DESIGN_BUTTON_ALIGNS.map((mode) => (
                          <TabsTrigger
                            key={mode}
                            value={mode}
                            aria-label={BUTTON_ALIGN_TITLES[mode]}
                            disabled={design?.button?.width === 'full'}
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="flex items-center">
                                  {BUTTON_ALIGN_ICONS[mode]}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{BUTTON_ALIGN_TITLES[mode]}</TooltipContent>
                            </Tooltip>
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </Tabs>
                  </Field>
                  <Field label="Размер шрифта" id="design-btn-font" className="flex-1">
                    <NumberRow
                      className={CONTROL_BOX}
                      id="design-btn-font"
                      value={design?.button?.fontSize}
                      // Зеркалит --rf-submit-size: 16 × --rf-ratio-small (0.875) = 14.
                      fallback={14}
                      min={MIN_BUTTON_FONT}
                      max={MAX_BUTTON_FONT}
                      onChange={(n) => set('button', 'fontSize', n)}
                    />
                  </Field>
                  <Field label="Радиус" id="design-btn-radius" className="flex-1">
                    <NumberRow
                      className={CONTROL_BOX}
                      id="design-btn-radius"
                      value={design?.button?.radius}
                      // Зеркалит --rf-submit-radius: пока не задан, кнопка берёт радиус
                      // контролов (--rf-radius, 6px).
                      fallback={6}
                      min={MIN_BUTTON_RADIUS}
                      max={MAX_BUTTON_RADIUS}
                      onChange={(n) => set('button', 'radius', n)}
                    />
                  </Field>
                </div>
              </Wide>
              {/* ТОЛЩИНА — ОТДЕЛЬНОЙ СТРОКОЙ ВО ВСЮ ШИРИНУ (решение владельца
                  2026-09-07). Не четвёртой в ряду с кеглем и радиусом: там числа в
                  узких полях, а здесь список со словами. И обязательно в Wide: секция
                  это сетка из двух колонок, и голое поле встало бы в пару к первому
                  цвету кнопки — соседями по строке оказались бы настройки разных
                  жанров. Ступени, а не число, — довод в DESIGN_BUTTON_WEIGHTS. */}
              <Wide>
                <Field label="Толщина" id="design-btn-weight">
                  <Choice
                    id="design-btn-weight"
                    value={design?.button?.weight ?? 'semibold'}
                    options={DESIGN_BUTTON_WEIGHTS}
                    titles={BUTTON_WEIGHT_TITLES}
                    onChange={(v) => set('button', 'weight', dflt(v, 'semibold'))}
                  />
                </Field>
              </Wide>

              {/* Цвета кнопки — теми же строками, что у полей: образец слева, hex в
                  поле, цвет темы, пока автор своего не задал. Подписи короткие —
                  секция уже сказала, о чьём фоне и тексте речь. */}
              {BUTTON_PALETTE_FIELDS.map(({ key, title }) => (
                <ColorRow
                  key={key}
                  id={`design-color-${key}`}
                  title={title}
                  value={design?.palette?.[key]}
                  fromTheme={themeColor(base, key)}
                  onChange={(hex) => set('palette', key, hex, `design:palette:${key}`)}
                  onRemove={() => set('palette', key, undefined)}
                />
              ))}
              {/* ВОЗДУХ КНОПКИ — последним в секции: сначала автор решает, какая
                  кнопка, и только потом, сколько места вокруг неё.

                  Отступ ТОЛЬКО СВЕРХУ (решение владельца 2026-08-29): воздух под
                  кнопкой — поле страницы, а не свойство кнопки. Он ДОБАВЛЯЕТСЯ к
                  расстоянию, которое уже держит колонка (gap .rf-page, 24px ×
                  плотность), поэтому дефолт — ноль, а не 24: иначе автор, выставив
                  24, не увидел бы никакой разницы.

                  Боковые поля сильнее готового размера — как и высота. Раньше их
                  задавал только он, а с его уходом из панели задать их стало нечем. */}
              <Field label="Отступ сверху" id="design-btn-mt">
                <NumberRow
                  className={CONTROL_BOX}
                  id="design-btn-mt"
                  value={design?.button?.marginTop}
                  // Зеркалит --rf-submit-mt: своего воздуха у кнопки по умолчанию нет.
                  fallback={0}
                  min={MIN_BUTTON_MARGIN_TOP}
                  max={MAX_BUTTON_MARGIN_TOP}
                  onChange={(n) => set('button', 'marginTop', n)}
                />
              </Field>
              <Field label="Отступ по бокам" id="design-btn-px">
                <NumberRow
                  className={CONTROL_BOX}
                  id="design-btn-px"
                  value={design?.button?.paddingX}
                  // Зеркалит --rf-submit-px (1.5rem).
                  fallback={24}
                  min={MIN_BUTTON_PADDING_X}
                  max={MAX_BUTTON_PADDING_X}
                  onChange={(n) => set('button', 'paddingX', n)}
                />
              </Field>
            </Group>
          </section>

          <Separator />

          {/* СВОЙ CSS — последней секцией, и это не про важность: остальные настройки
              покрывают то, что должно быть под рукой, а сюда спускаются, когда их не
              хватило. Поле голое, без подсветки и автодополнения: редактор кода в
              шторке шириной в 26rem — это обещание удобства, которого мы не дадим,
              а CSS сюда приносят готовым. */}
          <Group title="Свой CSS" locked={!canUseCSS}>
            {/* Предупреждение — ПОД ЗАГОЛОВКОМ, а не под полем (решение владельца
                2026-08-28), как и у «Дополнительно»: последствие относится ко всей
                секции, а не к последней её строке, и внизу оно вдобавок оказывалось
                под двумя серыми подсказками — то есть там, куда дочитывают не все. */}
            {design?.css && !canUseCSS && (
              <Wide>
                <Warning>
                  На бесплатном тарифе форму с этим CSS не опубликовать. Черновик сохранится.
                </Warning>
              </Wide>
            )}
            <Wide>
              {/* ПОЛЕ С ПОДСВЕТКОЙ, А НЕ ГОЛАЯ TEXTAREA (решение владельца
                  2026-08-28). Прежний довод — «редактор кода в шторке шириной в 26rem
                  это обещание удобства, которого мы не дадим» — против подсветки не
                  работает: она ничего не обещает сверх раскраски и не требует ни
                  автодополнения, ни номеров строк, ни сворачивания блоков. Поле
                  осталось полем; на тёмном полотне кода (--code, «это не кабинет» —
                  DESIGN-SYSTEM §6) видно, где кончился селектор и началось значение. */}
              <CodeField
                id="design-css"
                value={cssValue}
                lang="css"
                onChange={setCss}
                maxLength={MAX_CUSTOM_CSS_LEN}
                rows={8}
                placeholder={'.my-block .rf-input {\n  border-radius: 0;\n}'}
              />
            </Wide>
            {cssInvalid && (
              <Wide>
                <p className="text-muted-foreground text-xs">
                  Последовательность <code>&lt;/</code> не допускается — уберите теги{' '}
                  <code>&lt;style&gt;</code>, оставьте только правила. Пока она есть, CSS не
                  сохраняется.
                </p>
              </Wide>
            )}
            <Wide>
              <p className="text-muted-foreground text-xs">
                Правила применяются к форме у респондента и в превью — на полотно редактора они не
                действуют. Пометьте блок своим именем в его настройках и обращайтесь к нему как к
                классу.
              </p>
            </Wide>
          </Group>

          {/* БЕЙДЖ ПЕРЕЕХАЛ на экран «Встроить» (решение владельца 2026-08-16): автор
              думает про него, когда решает, как форма выглядит на сайте, а не когда
              подбирает цвета. Настройка та же — `design.branding` в схеме. */}
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
              Готовая тема заменит оформление целиком: свои цвета, шрифт, лэйаут, поля и кнопки
              будут сброшены. Отменить это можно будет через Ctrl+Z.
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

// Две колонки (решение владельца 2026-08-09): контролов в панели полтора десятка, и
// в один столбец они уезжают за пределы экрана — до кнопки приходилось скроллить,
// не видя формы, ради которой панель и открыта. Заголовок группы занимает обе.
// locked — метка «Pro» у заголовка группы. Именно метка, а не disabled у контролов:
// настройка остаётся доступной (черновик сохранится на любом тарифе), закрыт только
// результат — публикация или отдача. Показывает панель, отказывает бэк (инвариант 3).
//
// Кегль заголовка группы — 14/600, на ступень ниже раздела и на ступень выше подписи
// (решение владельца 2026-08-29). До этого 16/600: рядом с ужатыми до 28px контролами и
// подписями в 12 он читался вторым уровнем страницы, а не оглавлением ряда настроек.
//
// Слово, а не один замок (решение владельца 2026-08-10): замок сообщает «нельзя», но
// не сообщает ЧТО с этим делать, и на секции, где половина настроек бесплатна, читался
// как поломка. «Pro» называет тариф, на котором это работает.
//
// Без заголовка группа тоже бывает — верхний раздел основных настроек. Отдельной
// вёрсткой он не заводится: сетка у всех разделов одна, и две её копии разъехались
// бы при первой же правке ритма.
function Group({
  title,
  children,
  locked = false,
}: {
  title?: string
  children: ReactNode
  locked?: boolean
}) {
  return (
    <section className="grid grid-cols-2 gap-x-4 gap-y-4">
      {title !== undefined && (
        <h3 className="col-span-2 flex items-center gap-2 text-sm font-semibold">
          {title}
          {locked && <ProTag />}
        </h3>
      )}
      {children}
    </section>
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
// group — контрол не является полем ввода (набор кнопок): `htmlFor` на нём молча ни к
// чему не привязывается, поэтому подпись становится обычным текстом со своим id, а
// контрол берёт её через `aria-labelledby`. Разница не видна глазом и слышна вслух.
function Field({
  label,
  id,
  group = false,
  className,
  children,
}: {
  label: string
  id: string
  group?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('grid gap-1', className)}>
      {group ? (
        <span id={`${id}-label`} className={LABEL}>
          {label}
        </span>
      ) : (
        <Label htmlFor={id} className={LABEL}>
          {label}
        </Label>
      )}
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
      <SelectTrigger id={id} size="sm" className={`w-full ${CONTROL_SELECT}`}>
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

// СТРОКА ЦВЕТА — ПОЛЕ ВВОДА С ОБРАЗЦОМ СЛЕВА, а не кнопка, открывающая выборщик
// (решение владельца 2026-08-28). Цвет чаще приносят готовым — из макета, из брендбука,
// из соседней формы, — и путь «открыть поповер, найти в нём поле hex, вставить, закрыть»
// это четыре жеста там, где хватает одного. Выборщик остаётся на образце: подобрать
// глазами по-прежнему можно, но за этим теперь идут, а не проходят мимо.
//
// ПОКАЗЫВАЕТСЯ ТО, ЧТО НАРИСОВАНО, а не то, задавал автор этот цвет или нет. Незаданный
// цвет — не «пусто»: форма прямо сейчас рисуется каким-то холстом и каким-то текстом, и
// автору нужен именно он — от него он и отталкивается, подбирая свой.
//
// fromTheme — цвет базовой темы (designDefaults.ts); null у цветов, которых в зеркале
// нет: там остаются шашечки — «цвет есть, а какой, мы не знаем» честнее подставленного
// чёрного.
function ColorRow({
  id,
  title,
  value,
  fromTheme,
  onChange,
  onRemove,
}: {
  id: string
  title: string
  value: string | undefined
  fromTheme: string | null
  onChange: (hex: string) => void
  onRemove: () => void
}) {
  const shown = value ?? fromTheme

  // Черновик поля отдельно от цвета — тот же приём, что у hex внутри выборщика и у имени
  // блока: пока автор дописывает «#7c3», значение ещё не цвет, и в документ ему нельзя.
  // null — «поле показывает текущий цвет».
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? shown ?? ''

  // Пустое поле СНИМАЕТ цвет, а не отвергается: стереть значение — понятный способ
  // сказать «пусть будет как в теме», и другого в строке нет.
  const type = (next: string) => {
    setDraft(next)
    const hex = next.trim().toLowerCase()
    if (hex === '') onRemove()
    else if (isHexColor(hex)) onChange(hex)
  }

  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className={LABEL}>
        {title}
      </Label>
      <div className="relative">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Подобрать цвет: ${title}`}
              title="Подобрать цвет"
              className="absolute top-1/2 left-1.5 z-10 size-5 -translate-y-1/2 cursor-pointer rounded-sm border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              style={
                shown
                  ? { background: shown }
                  : {
                      backgroundImage:
                        'linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)',
                      backgroundSize: '6px 6px',
                      backgroundPosition: '0 0,3px 3px',
                    }
              }
            />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <ColorPicker
              initial={shown ?? '#3d3d3d'}
              swatches={SWATCHES}
              removeLabel="Вернуть цвет темы"
              // Выборщик пишет в тот же стор, что и поле, поэтому черновик под ним нужно
              // снять: иначе подобранный мышью цвет не доехал бы до поля, и строка
              // показывала бы одно, а форма — другое.
              onChange={(hex) => {
                setDraft(null)
                onChange(hex)
              }}
              onRemove={() => {
                setDraft(null)
                onRemove()
              }}
            />
          </PopoverContent>
        </Popover>
        <Input
          id={id}
          value={text}
          spellCheck={false}
          // Незаконченный ввод помечается, но не мешает печатать: красная рамка гаснет
          // сама, как только набранное становится цветом.
          aria-invalid={
            draft !== null && draft.trim() !== '' && !isHexColor(draft.trim().toLowerCase())
          }
          onChange={(e) => type(e.target.value)}
          // Уход из поля возвращает в него настоящее значение: недописанный «#7c3» иначе
          // остался бы висеть текстом, которого нет ни в документе, ни на форме.
          onBlur={() => setDraft(null)}
          className={`w-full pl-8 font-mono ${CONTROL_BOX}`}
        />
      </div>
    </div>
  )
}

// ПРЕДУПРЕЖДЕНИЕ — ЖЁЛТОЕ (решение владельца 2026-08-28): роль `--warning` из палитры
// кабинета, а не свой оттенок (DESIGN-SYSTEM §6). До этого оно было серым и стояло
// подписью среди таких же серых подсказок панели — то есть предупреждало ровно тех, кто
// и так читает всё подряд.
//
// ЦВЕТ НЕСЁТ ЗНАЧОК И ПОДЛОЖКА, А НЕ ТЕКСТ: `--warning` держит 3.19:1 к белому — хватает
// графике (AA требует от неё 3:1) и не хватает тексту (4.5:1). Покрасить им буквы значило
// бы сделать предупреждение самым нечитаемым абзацем панели.
function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="border-warning/40 bg-warning/10 flex gap-2 rounded-md border p-4 text-sm">
      <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" />
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
const FONT_TITLES: Record<string, string> = {
  inter: 'Inter',
  golos: 'Golos Text',
  manrope: 'Manrope',
  onest: 'Onest',
  montserrat: 'Montserrat',
  lora: 'Lora',
}
// Толщина надписи кнопки. Подписи русские и привычные по текстовым редакторам:
// «полужирный» и «жирный» — те же слова, что у марок текста на полотне.
const BUTTON_WEIGHT_TITLES: Record<string, string> = {
  normal: 'Обычный',
  medium: 'Средний',
  semibold: 'Полужирный',
  bold: 'Жирный',
}
// Порядок вкладок — решение владельца 2026-08-29: полная ширина первой.
const FIELD_WIDTH_MODES = ['full', 'fixed'] as const
const FIELD_WIDTH_TITLES: Record<string, string> = {
  fixed: 'Фиксированная ширина',
  full: 'Полная ширина',
}
// Значки — те же, что у ширины ПОЛЯ (стрелка наружу — полная, стрелка к точке —
// фиксированная): один вопрос, заданный дважды, обязан выглядеть одинаково. Третий,
// «по тексту», — стрелка к черте: кнопка упирается в конец своего текста.
const BUTTON_ALIGN_ICONS: Record<string, ReactNode> = {
  left: <AlignLeft className="size-4" />,
  center: <AlignCenter className="size-4" />,
  right: <AlignRight className="size-4" />,
}
const BUTTON_ALIGN_TITLES: Record<string, string> = {
  left: 'Слева',
  center: 'По середине',
  right: 'Справа',
}
const BUTTON_WIDTH_ICONS: Record<string, ReactNode> = {
  auto: <ArrowRightToLine className="size-4" />,
  full: <MoveHorizontal className="size-4" />,
  fixed: <ArrowDownToDot className="size-4" />,
}
const BUTTON_WIDTH_TITLES: Record<string, string> = {
  auto: 'По тексту',
  full: 'Полная ширина',
  fixed: 'Фиксированная',
}
