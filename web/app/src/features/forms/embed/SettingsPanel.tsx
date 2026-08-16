import { Link } from '@tanstack/react-router'

import {
  DEFAULT_BLOCK_HEIGHT,
  MODE_HINTS,
  MODE_TITLES,
  type EmbedMode,
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
import { Switch } from '@/components/ui/switch'

// Настройки вставки. ВСЕ ОНИ ЖИВУТ В САМОМ СНИППЕТЕ и никогда на сервере (ADR §10):
// одна форма вставляется в несколько мест по-разному, и серверная копия настроек
// спорила бы с двумя другими вставками. Поэтому здесь нет ни сохранения, ни
// «применить» — панель просто печатает код и перестраивает макет.

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
  /** Вставка без загрузчика — голым `<iframe>`; у виджета невозможна. */
  plain: boolean
}

export function SettingsPanel({
  slug,
  mode,
  onModeChange,
  settings,
  onChange,
  multipage,
}: {
  slug: string
  mode: EmbedMode
  onModeChange: (mode: EmbedMode) => void
  settings: EmbedSettings
  onChange: (patch: Partial<EmbedSettings>) => void
  /** У формы есть разрывы страниц — единственная подсказка выбора не про вкус. */
  multipage: boolean
}) {
  const widget = mode === 'widget'
  // Виджета без скрипта не существует: показать модалку по кнопке голому iframe нечем.
  const plainAvailable = !widget
  const plain = settings.plain && plainAvailable

  return (
    <div className="space-y-5">
      <div>
        <Label htmlFor="embed-mode">Вид вставки</Label>
        <Select value={mode} onValueChange={(v) => onModeChange(v as EmbedMode)}>
          <SelectTrigger id="embed-mode" className="mt-1 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="block">{MODE_TITLES.block}</SelectItem>
            <SelectItem value="widget">{MODE_TITLES.widget}</SelectItem>
            <SelectItem value="page">{MODE_TITLES.page}</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-muted-foreground">{MODE_HINTS[mode]}</p>
        {multipage && mode === 'block' && (
          <p className="mt-2 text-xs text-muted-foreground">
            У формы есть разрывы страниц — во встроенном виде ей обычно лучше подходит
            «Страница»: шаг помещается в экран целиком.
          </p>
        )}
      </div>

      {widget ? (
        <>
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
            <Label htmlFor="embed-position">Угол экрана</Label>
            <Select
              value={settings.position}
              onValueChange={(v) => onChange({ position: v as WidgetPosition })}
            >
              <SelectTrigger id="embed-position" className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bottom-right">Справа внизу</SelectItem>
                <SelectItem value="bottom-left">Слева внизу</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      ) : (
        <div>
          <Label htmlFor="embed-height">
            {plain ? 'Высота, px' : 'Высота до загрузки формы, px'}
          </Label>
          <Input
            id="embed-height"
            type="number"
            min={200}
            max={2000}
            value={settings.height}
            disabled={mode === 'page'}
            onChange={(e) => onChange({ height: Number(e.target.value) || DEFAULT_BLOCK_HEIGHT })}
            className="mt-1"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {mode === 'page'
              ? 'В полноэкранном режиме высоту задаёт окно посетителя.'
              : plain
                ? 'Без скрипта высота фиксированная: подстраиваться под длину формы нечем.'
                : 'Дальше высоту ведёт сама форма — это лишь размер до её загрузки.'}
          </p>
        </div>
      )}

      <div className="space-y-3 border-t pt-4">
        <Toggle
          id="embed-hide-title"
          checked={settings.hideTitle}
          onChange={(v) => onChange({ hideTitle: v })}
          text="Скрыть заголовок формы"
          hint="На странице обычно уже есть свой заголовок над формой."
        />
        <Toggle
          id="embed-align"
          checked={settings.alignLeft}
          onChange={(v) => onChange({ alignLeft: v })}
          text="Выровнять содержимое влево"
          hint="Перебивает выравнивание из оформления — только в этой вставке."
        />
        {!widget && (
          <Toggle
            id="embed-bg"
            checked={settings.transparent}
            onChange={(v) => onChange({ transparent: v })}
            text="Прозрачный фон"
            hint="Форма ляжет на фон сайта, а не белым прямоугольником."
          />
        )}
        <Toggle
          id="embed-plain"
          checked={plain}
          disabled={!plainAvailable}
          onChange={(v) => onChange({ plain: v })}
          text="Без скрипта, простым iframe"
          hint={
            plainAvailable
              ? 'Нужно, если сайт запрещает сторонние скрипты. Цена — фиксированная высота.'
              : 'Виджету нужен скрипт: показать окно по кнопке простой рамкой невозможно.'
          }
        />
      </div>

      {/* БЕЙДЖ — НЕ НАСТРОЙКА ВСТАВКИ, и тумблера здесь нет намеренно: он живёт в
          оформлении формы и упирается в тариф (гейт `form_branding` на отдаче
          публичной формы, BILLING.md). Атрибутом сниппета его снять было бы нельзя —
          это обход платного гейта данными с чужой страницы. */}
      <p className="border-t pt-4 text-xs text-muted-foreground">
        Бейдж «Сделано в Trillix» настраивается в{' '}
        <Link
          to="/forms/$slug/edit"
          params={{ slug }}
          search={(prev) => prev}
          className="underline underline-offset-2"
        >
          оформлении формы
        </Link>{' '}
        и одинаков во всех вставках.
      </p>
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
