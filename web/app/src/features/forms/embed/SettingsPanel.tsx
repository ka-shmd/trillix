import { type ReactNode } from 'react'

import { type FormDetail } from '../../../entities/form'
import { useFeatureAllowed } from '../../plan/useFeature'
import { useUpdateBranding } from '../queries'
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_WIDGET_WIDTH,
  OPEN_TRIGGERS,
  WIDGET_POSITIONS,
  type EmbedMode,
  type OpenTrigger,
  type WidgetPosition,
} from '../embedSnippet'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'

// Настройки вставки. ВСЕ ОНИ ЖИВУТ В САМОМ СНИППЕТЕ и никогда на сервере (ADR §10):
// одна форма вставляется в несколько мест по-разному, и серверная копия настроек
// спорила бы с двумя другими вставками. Поэтому здесь нет ни сохранения, ни
// «применить» — панель просто печатает код и перестраивает макет.
//
// ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ — бейдж внизу: он свойство ФОРМЫ (оформление + тариф), и
// потому единственный, кто здесь что-то сохраняет. Почему он всё же тут — решение
// владельца 2026-08-16: автор думает про вид вставки в одном месте.
//
// У КАЖДОГО ВИДА ВСТАВКИ СВОЙ НАБОР НАСТРОЕК, и они разведены по трём веткам, а не
// собраны в один список с условиями у каждой строки: общего у видов — только бейдж.

// Вид вставки в этот объект НЕ входит: он живёт в адресе экрана и приезжает пропом.
// Держать его ещё и здесь значило бы синхронизировать состояние с URL эффектом —
// две правды об одном значении и лишний рендер на каждый переход «Назад».
export interface EmbedSettings {
  label: string
  position: WidgetPosition
  transparent: boolean
  hideTitle: boolean
  alignLeft: boolean
  height: number
  dynamicHeight: boolean
  width: number
  overlay: boolean
  open: OpenTrigger
  openValue: number
  hideOnSubmit: boolean
  /** Вставка без загрузчика — голым `<iframe>`; у виджета невозможна. */
  plain: boolean
}

interface ModeProps {
  settings: EmbedSettings
  onChange: (patch: Partial<EmbedSettings>) => void
}

export function SettingsPanel({
  form,
  mode,
  settings,
  onChange,
}: {
  form: FormDetail
  mode: EmbedMode
  settings: EmbedSettings
  onChange: (patch: Partial<EmbedSettings>) => void
}) {
  return (
    <div className="flex flex-col gap-6">
      {mode === 'block' && <BlockSettings settings={settings} onChange={onChange} />}
      {mode === 'widget' && <WidgetSettings settings={settings} onChange={onChange} />}
      {mode === 'page' && <PageSettings settings={settings} onChange={onChange} />}
      <Separator />
      <BadgeToggle form={form} />
    </div>
  )
}

// БЛОК — форма в потоке чужой страницы. Настройки идут тремя связками — сколько
// места занимает, как выглядит, чем вставляется, — но БЕЗ ЗАГОЛОВКОВ (решение
// владельца 2026-08-27): связки различает просвет, а подписи над двумя-тремя
// строками сами становились шумом, от которого их заводили.
function BlockSettings({ settings, onChange }: ModeProps) {
  // Виджета без скрипта не существует, а у блока — вполне: голый фрейм не умеет
  // только живую высоту.
  const plain = settings.plain

  return (
    <>
      <Group>
        <Field id="embed-height" label="Высота">
          {/* Единица измерения — В ПОЛЕ, а не в подписи: «Высота» отвечает на «что»,
              «px» на «в чём», и вместе они читаются одной строкой. Кегль и вес у них
              общие — иначе «px» читается не концом строки, а меткой поверх неё.
              Кегль поднят ТЕМ ЖЕ вариантом, каким задан у компонента (`md:text-sm`):
              плоский `text-base` его не пересилил бы.
              ПОЛЕ СПРАВА ОСТАВЛЯЕТ МЕСТО ДВОИМ: стрелки счётчика браузер рисует у
              правого края СОДЕРЖИМОГО, то есть внутри этого отступа, а «px» стоит
              правее — в самом отступе. Уменьшишь `pr` — они наедут друг на друга. */}
          <div className="relative">
            <Input
              id="embed-height"
              type="number"
              inputMode="numeric"
              min={200}
              max={2000}
              value={settings.height}
              onChange={(e) => onChange({ height: Number(e.target.value) || DEFAULT_BLOCK_HEIGHT })}
              className="pr-9 font-medium md:text-base"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-base font-medium text-muted-foreground">
              px
            </span>
          </div>
        </Field>
        <Toggle
          id="embed-dynamic-height"
          checked={settings.dynamicHeight && !plain}
          disabled={plain}
          onChange={(v) => onChange({ dynamicHeight: v })}
          text="Живая высота"
          hint={plain ? 'Без скрипта высота не подстраивается.' : 'Блок растёт вместе с формой.'}
        />
      </Group>

      <Group>
        <Toggle
          id="embed-hide-title"
          checked={settings.hideTitle}
          onChange={(v) => onChange({ hideTitle: v })}
          text="Скрыть заголовок формы"
          hint="На странице обычно уже есть свой заголовок над формой."
        />
        {/* Прижатие влево — только у блока: у виджета и страницы поля холста
            отделяют форму от края панели и края экрана, и снимать их там незачем. */}
        <Toggle
          id="embed-align"
          checked={settings.alignLeft}
          onChange={(v) => onChange({ alignLeft: v })}
          text="Выровнять содержимое влево"
          hint="Форма начнётся от левого края блока, без полей по бокам."
        />
        <Toggle
          id="embed-bg"
          checked={settings.transparent}
          onChange={(v) => onChange({ transparent: v })}
          text="Прозрачный фон"
          hint="Форма ляжет на фон сайта, а не белым прямоугольником."
        />
      </Group>

      <Group>
        <Toggle
          id="embed-plain"
          checked={plain}
          onChange={(v) => onChange({ plain: v })}
          text="Без скрипта, простым iframe"
          hint="Для сайтов, где запрещены сторонние скрипты."
        />
      </Group>
    </>
  )
}

// Виджет и страница ждут своей очереди редизайна (решение владельца 2026-08-27):
// набор контролов у них прежний, изменился только каркас вокруг.
function WidgetSettings({ settings, onChange }: ModeProps) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Label htmlFor="embed-open">Когда открывать</Label>
        <Select value={settings.open} onValueChange={(v) => onChange({ open: v as OpenTrigger })}>
          <SelectTrigger id="embed-open" className="mt-1 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(OPEN_TRIGGERS).map(([value, title]) => (
              <SelectItem key={value} value={value}>
                {title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Единственная подсказка, которую автор иначе прочтёт как поломку:
            проверит настройку, закроет панель и не дождётся повторного показа. */}
        {settings.open !== 'click' && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Откроется один раз за визит. Дальше — по кнопке.
          </p>
        )}
      </div>

      {(settings.open === 'delay' || settings.open === 'scroll') && (
        <div>
          <Label htmlFor="embed-open-value">
            {settings.open === 'delay' ? 'Пауза, секунд' : 'Прокрутка, %'}
          </Label>
          <Input
            id="embed-open-value"
            type="number"
            min={1}
            max={settings.open === 'delay' ? 120 : 100}
            value={settings.openValue}
            onChange={(e) => onChange({ openValue: Number(e.target.value) || 0 })}
            className="mt-1"
          />
        </div>
      )}

      <div>
        <Label htmlFor="embed-position">Угол экрана</Label>
        <Select
          value={settings.position}
          onValueChange={(v) => onChange({ position: v as WidgetPosition })}
        >
          <SelectTrigger id="embed-position" className="mt-1 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(WIDGET_POSITIONS).map(([value, title]) => (
              <SelectItem key={value} value={value}>
                {title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="embed-label">Надпись на кнопке</Label>
        <Input
          id="embed-label"
          value={settings.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="embed-width">Ширина панели, px</Label>
        <Input
          id="embed-width"
          type="number"
          min={280}
          max={720}
          value={settings.width}
          onChange={(e) => onChange({ width: Number(e.target.value) || DEFAULT_WIDGET_WIDTH })}
          className="mt-1"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          На телефоне панель раскрывается во весь экран.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        <Toggle
          id="embed-hide-title"
          checked={settings.hideTitle}
          onChange={(v) => onChange({ hideTitle: v })}
          text="Скрыть заголовок формы"
          hint="На странице обычно уже есть свой заголовок над формой."
        />
        <Toggle
          id="embed-overlay"
          checked={settings.overlay}
          onChange={(v) => onChange({ overlay: v })}
          text="Затемнять страницу"
          hint="Страница за панелью темнеет."
        />
        <Toggle
          id="embed-hide-on-submit"
          checked={settings.hideOnSubmit}
          onChange={(v) => onChange({ hideOnSubmit: v })}
          text="Убрать виджет после отправки"
          hint="Ответивший больше не увидит кнопку до перезагрузки страницы."
        />
      </div>
    </div>
  )
}

function PageSettings({ settings, onChange }: ModeProps) {
  return (
    <div className="flex flex-col gap-3">
      <Toggle
        id="embed-bg"
        checked={settings.transparent}
        onChange={(v) => onChange({ transparent: v })}
        text="Прозрачный фон"
        hint="Форма ляжет на фон сайта, а не белым прямоугольником."
      />
      <Toggle
        id="embed-plain"
        checked={settings.plain}
        onChange={(v) => onChange({ plain: v })}
        text="Без скрипта, простым iframe"
        hint="Для сайтов, где запрещены сторонние скрипты."
      />
    </div>
  )
}

// БЕЙДЖ — единственная настройка экрана, которая сохраняется: она свойство формы, а не
// вставки, и действует на все вставки и на прямую ссылку разом. Переехал сюда из шторки
// оформления (решение владельца 2026-08-16).
//
// Гейт у него ДРУГОЙ природы, чем у остального оформления: публикацию он не держит
// (снять намерение можно на любом тарифе), а срабатывает при отдаче формы — поэтому на
// бесплатном тарифе выключенный переключатель честно предупреждает, что бейдж всё
// равно останется.
function BadgeToggle({ form }: { form: FormDetail }) {
  const canRemove = useFeatureAllowed('form_branding')
  const update = useUpdateBranding()
  const show = form.draftSchema.design?.branding !== false

  return (
    <Group>
      <Toggle
        id="embed-branding"
        checked={show}
        disabled={update.isPending}
        onChange={(v) => update.mutate({ form, show: v })}
        text="Показывать «Сделано в Trillix»"
        hint="Настройка всей формы: действует и на прямую ссылку."
      />
      {!show && !canRemove && (
        <p className="text-xs text-muted-foreground">
          На бесплатном тарифе бейдж остаётся на форме. Настройка сохранится и сработает сразу после
          перехода на платный.
        </p>
      )}
      {form.publishedVersion !== null && (
        <p className="text-xs text-muted-foreground">
          На опубликованной форме применится после следующей публикации.
        </p>
      )}
      {update.isError && (
        <p className="text-xs text-destructive" role="alert">
          Не удалось сохранить. Если форма открыта в редакторе в другой вкладке — обновите страницу
          и попробуйте ещё раз.
        </p>
      )}
    </Group>
  )
}

// Связка настроек — просвет вокруг и ничего больше: заголовков у связок нет
// (решение владельца 2026-08-27), их работу делает ритм колонки.
function Group({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-3">{children}</section>
}

// Поле с подписью над контролом — тот же порядок, что у строки с тумблером. Просвет
// 8, а не 4: четвёрка в ритме кабинета означает «заголовок и его подпись», то есть
// склеивает две строки в одну пару, а подпись и поле ввода — соседи (DESIGN-SYSTEM §5).
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {/* Вес обычный, а не 600 из шкалы: рядом стоят подписи тумблеров, у них он тоже
          обычный, и полужирная строка над полем читалась бы заголовком связки — тем
          самым, который отсюда убрали. */}
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      {children}
    </div>
  )
}

function Toggle({
  id,
  checked,
  onChange,
  text,
  hint,
  disabled = false,
}: {
  id: string
  checked: boolean
  onChange: (value: boolean) => void
  text: string
  hint: string
  disabled?: boolean
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
        <Label htmlFor={id} className="font-normal">
          {text}
        </Label>
      </div>
      <p className="mt-1 ml-10 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
