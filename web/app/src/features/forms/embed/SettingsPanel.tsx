import { type FormDetail } from '../../../entities/form'
import { useFeatureAllowed } from '../../plan/useFeature'
import { useUpdateBranding } from '../queries'
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_WIDGET_WIDTH,
  EMOJI_ANIMATIONS,
  MODE_HINTS,
  MODE_TITLES,
  OPEN_TRIGGERS,
  WIDGET_POSITIONS,
  type EmbedMode,
  type EmojiAnimation,
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
import { Switch } from '@/components/ui/switch'

// Настройки вставки. ВСЕ ОНИ ЖИВУТ В САМОМ СНИППЕТЕ и никогда на сервере (ADR §10):
// одна форма вставляется в несколько мест по-разному, и серверная копия настроек
// спорила бы с двумя другими вставками. Поэтому здесь нет ни сохранения, ни
// «применить» — панель просто печатает код и перестраивает макет.
//
// ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ — бейдж внизу: он свойство ФОРМЫ (оформление + тариф), и
// потому единственный, кто здесь что-то сохраняет. Почему он всё же тут — решение
// владельца 2026-08-16: автор думает про вид вставки в одном месте.

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
  emoji: string
  emojiAnimation: EmojiAnimation
  hideOnSubmit: boolean
  /** Вставка без загрузчика — голым `<iframe>`; у виджета невозможна. */
  plain: boolean
}

export function SettingsPanel({
  form,
  mode,
  onModeChange,
  settings,
  onChange,
}: {
  form: FormDetail
  mode: EmbedMode
  onModeChange: (mode: EmbedMode) => void
  settings: EmbedSettings
  onChange: (patch: Partial<EmbedSettings>) => void
}) {
  const widget = mode === 'widget'
  const page = mode === 'page'
  // Виджета без скрипта не существует: показать панель по кнопке голому iframe нечем.
  const plain = settings.plain && !widget
  // У формы есть разрывы страниц — единственная подсказка выбора не про вкус.
  const multipage = form.draftSchema.blocks.some((b) => b.type === 'page_break')

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

      {widget && (
        <>
          <div>
            <Label htmlFor="embed-open">Когда открывать</Label>
            <Select
              value={settings.open}
              onValueChange={(v) => onChange({ open: v as OpenTrigger })}
            >
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
            {/* Автооткрытие срабатывает один раз за визит — закрывший форму человек
                больше её не увидит, но кнопка остаётся. Это стоит сказать: иначе
                автор проверит настройку, закроет окно и решит, что она сломалась. */}
            {settings.open !== 'click' && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Откроется один раз за визит. Закрыв её, посетитель сможет вернуться кнопкой.
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
            <Label htmlFor="embed-emoji">Эмодзи на кнопке</Label>
            <Input
              id="embed-emoji"
              value={settings.emoji}
              placeholder="например, 👋"
              onChange={(e) => onChange({ emoji: e.target.value })}
              className="mt-1"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Показывается на углу открытой панели, не на кнопке.
            </p>
          </div>

          {settings.emoji !== '' && (
            <div>
              <Label htmlFor="embed-emoji-animation">Движение эмодзи</Label>
              <Select
                value={settings.emojiAnimation}
                onValueChange={(v) => onChange({ emojiAnimation: v as EmojiAnimation })}
              >
                <SelectTrigger id="embed-emoji-animation" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EMOJI_ANIMATIONS).map(([value, title]) => (
                    <SelectItem key={value} value={value}>
                      {title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

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
              На телефоне панель всё равно раскрывается во весь экран.
            </p>
          </div>
        </>
      )}

      {!widget && !page && (
        <div>
          <Label htmlFor="embed-height">
            {plain || !settings.dynamicHeight ? 'Высота, px' : 'Высота до загрузки формы, px'}
          </Label>
          <Input
            id="embed-height"
            type="number"
            min={200}
            max={2000}
            value={settings.height}
            onChange={(e) => onChange({ height: Number(e.target.value) || DEFAULT_BLOCK_HEIGHT })}
            className="mt-1"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {plain || !settings.dynamicHeight
              ? 'Высота фиксированная: длинная форма будет скроллиться внутри блока.'
              : 'Дальше высоту ведёт сама форма — это лишь размер до её загрузки.'}
          </p>
        </div>
      )}

      <div className="space-y-3 border-t pt-4">
        {!widget && !page && (
          <Toggle
            id="embed-dynamic-height"
            checked={settings.dynamicHeight && !plain}
            disabled={plain}
            onChange={(v) => onChange({ dynamicHeight: v })}
            text="Живая высота"
            hint={
              plain
                ? 'Без скрипта подстраивать высоту нечем.'
                : 'Блок растёт вместе с формой, вместо того чтобы скроллиться внутри себя.'
            }
          />
        )}
        {!page && (
          <>
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
          </>
        )}
        {widget ? (
          <>
            <Toggle
              id="embed-overlay"
              checked={settings.overlay}
              onChange={(v) => onChange({ overlay: v })}
              text="Затемнять страницу"
              hint="С затемнением клик мимо панели закрывает её; без него сайт остаётся кликабельным."
            />
            <Toggle
              id="embed-hide-on-submit"
              checked={settings.hideOnSubmit}
              onChange={(v) => onChange({ hideOnSubmit: v })}
              text="Убрать виджет после отправки"
              hint="Ответивший больше не увидит кнопку до перезагрузки страницы."
            />
          </>
        ) : (
          <Toggle
            id="embed-bg"
            checked={settings.transparent}
            onChange={(v) => onChange({ transparent: v })}
            text="Прозрачный фон"
            hint="Форма ляжет на фон сайта, а не белым прямоугольником."
          />
        )}
        {!widget && (
          <Toggle
            id="embed-plain"
            checked={plain}
            onChange={(v) => onChange({ plain: v })}
            text="Без скрипта, простым iframe"
            hint="Нужно, если сайт запрещает сторонние скрипты. Цена — фиксированная высота."
          />
        )}
      </div>

      <BadgeToggle form={form} />
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
    <div className="border-t pt-4">
      <Toggle
        id="embed-branding"
        checked={show}
        disabled={update.isPending}
        onChange={(v) => update.mutate({ form, show: v })}
        text="Показывать «Сделано в Trillix»"
        hint="Настройка формы, а не вставки: действует и на прямую ссылку тоже."
      />
      {!show && !canRemove && (
        <p className="mt-2 text-xs text-muted-foreground">
          На бесплатном тарифе бейдж остаётся на форме. Настройка сохранится и сработает сразу
          после перехода на платный.
        </p>
      )}
      {form.publishedVersion !== null && (
        <p className="mt-2 text-xs text-muted-foreground">
          На опубликованной форме применится после следующей публикации.
        </p>
      )}
      {update.isError && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          Не удалось сохранить. Если форма открыта в редакторе в другой вкладке — обновите
          страницу и попробуйте ещё раз.
        </p>
      )}
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
