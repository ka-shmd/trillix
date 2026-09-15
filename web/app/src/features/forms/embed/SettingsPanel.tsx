import { useState, type ReactNode } from 'react'

import { type FormDetail } from '../../../entities/form'
import { PlanUpsell } from '../../plan/PlanUpsell'
import { useFeatureAllowed } from '../../plan/useFeature'
import { ProTag } from '../../../shared/ProTag'
import { useUpdateBranding } from '../queries'
import {
  DEFAULT_BLOCK_HEIGHT,
  OPEN_TRIGGERS,
  WIDGET_POSITIONS,
  widgetDefaults,
  type EmbedMode,
  type OpenTrigger,
  type WidgetPosition,
} from '../embedSnippet'
import { CircleHelp } from 'lucide-react'
import { RAISED_INPUT, RAISED_SELECT } from '../../../shared/raisedField'

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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

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
  // СТРОКИ РАЗДЕЛЕНЫ ЧЕРТОЙ (решение владельца 2026-08-27), и черту рисует
  // контейнер (`divide-y`), а не строки: ветки вида отдают строки фрагментом, то
  // есть в DOM они прямые дети этого div'а, и выключенная условием строка уносит
  // свою черту сама. Строка, рисующая линию сверху, оставила бы её висеть.
  return (
    <div className="flex flex-col divide-y">
      {mode === 'block' && <BlockSettings settings={settings} onChange={onChange} />}
      {mode === 'widget' && <WidgetSettings settings={settings} onChange={onChange} />}
      {mode === 'page' && <PageSettings settings={settings} onChange={onChange} />}
      <BadgeToggle form={form} />
    </div>
  )
}

// БЛОК — форма в потоке чужой страницы. Настройки идут списком строк, разделённых
// чертой: заголовков у связок нет и пояснений под строками нет (решения владельца
// 2026-08-27) — подпись над двумя-тремя строками сама становилась шумом, от которого
// её заводили, а что делает настройка, показывает макет справа.
function BlockSettings({ settings, onChange }: ModeProps) {
  return (
    <>
      <Row>
        <Field id="embed-height" label="Высота">
          <WithUnit unit="px">
            <Input
              id="embed-height"
              type="number"
              inputMode="numeric"
              min={200}
              max={2000}
              value={settings.height}
              onChange={(e) => onChange({ height: Number(e.target.value) || DEFAULT_BLOCK_HEIGHT })}
              className={`pr-9 ${RAISED_INPUT}`}
            />
          </WithUnit>
        </Field>
      </Row>
      <Row>
        <Toggle
          id="embed-dynamic-height"
          checked={settings.dynamicHeight}
          onChange={(v) => onChange({ dynamicHeight: v })}
          text="Живая высота"
        />
      </Row>
      <Row>
        <Toggle
          id="embed-hide-title"
          checked={settings.hideTitle}
          onChange={(v) => onChange({ hideTitle: v })}
          text="Скрыть заголовок формы"
        />
      </Row>
      {/* Прижатие влево — только у блока: у виджета и страницы поля холста
          отделяют форму от края панели и края экрана, и снимать их там незачем. */}
      <Row>
        <Toggle
          id="embed-align"
          checked={settings.alignLeft}
          onChange={(v) => onChange({ alignLeft: v })}
          text="Выровнять содержимое влево"
        />
      </Row>
      <Row>
        <Toggle
          id="embed-bg"
          checked={settings.transparent}
          onChange={(v) => onChange({ transparent: v })}
          text="Прозрачный фон"
        />
      </Row>
    </>
  )
}

// Виджет и страница ждут своей очереди редизайна (решение владельца 2026-08-27):
// набор контролов у них прежний, изменился только каркас вокруг.
function WidgetSettings({ settings, onChange }: ModeProps) {
  // Окно по центру — не панель, потерявшая угол: у него своя ширина и своё умолчание
  // затемнения (`widgetDefaults`). Отсюда и разные подписи с потолком поля ниже.
  const centered = settings.position === 'center'
  return (
    <>
      <Row>
        <Field id="embed-open" label="Когда открывать">
          <Select value={settings.open} onValueChange={(v) => onChange({ open: v as OpenTrigger })}>
            <SelectTrigger id="embed-open" className={`w-full ${RAISED_SELECT}`}>
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
            <p className="text-xs text-muted-foreground">
              Откроется один раз за визит. Дальше — по кнопке.
            </p>
          )}
        </Field>
      </Row>

      {(settings.open === 'delay' || settings.open === 'scroll') && (
        <Row>
          <Field
            id="embed-open-value"
            label={settings.open === 'delay' ? 'Пауза, секунд' : 'Прокрутка, %'}
          >
            <Input
              id="embed-open-value"
              type="number"
              min={1}
              max={settings.open === 'delay' ? 120 : 100}
              value={settings.openValue}
              onChange={(e) => onChange({ openValue: Number(e.target.value) || 0 })}
              className={RAISED_INPUT}
            />
          </Field>
        </Row>
      )}

      <Row>
        <Field id="embed-position" label="Расположение">
          <Select
            value={settings.position}
            // Смена расположения приносит СВОИ умолчания вида: иначе окно по центру
            // открывалось бы шириной панели в углу и без затемнения, то есть тем
            // видом, от которого его и отличают.
            onValueChange={(v) =>
              onChange({
                position: v as WidgetPosition,
                ...widgetDefaults(v as WidgetPosition),
              })
            }
          >
            <SelectTrigger id="embed-position" className={`w-full ${RAISED_SELECT}`}>
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
        </Field>
      </Row>

      <Row>
        <Field id="embed-width" label={centered ? 'Ширина окна' : 'Ширина панели'}>
          <WithUnit unit="px">
            <Input
              id="embed-width"
              type="number"
              inputMode="numeric"
              min={280}
              max={centered ? 1100 : 720}
              value={settings.width}
              onChange={(e) =>
                onChange({
                  width: Number(e.target.value) || widgetDefaults(settings.position).width,
                })
              }
              className={`pr-9 ${RAISED_INPUT}`}
            />
          </WithUnit>
        </Field>
      </Row>

      <Row>
        <Toggle
          id="embed-hide-title"
          checked={settings.hideTitle}
          onChange={(v) => onChange({ hideTitle: v })}
          text="Скрыть заголовок формы"
        />
      </Row>
      <Row>
        <Toggle
          id="embed-overlay"
          checked={settings.overlay}
          onChange={(v) => onChange({ overlay: v })}
          text="Затемнять страницу"
        />
      </Row>
      <Row>
        <Toggle
          id="embed-hide-on-submit"
          checked={settings.hideOnSubmit}
          onChange={(v) => onChange({ hideOnSubmit: v })}
          text="Убрать виджет после отправки"
        />
      </Row>
    </>
  )
}

function PageSettings({ settings, onChange }: ModeProps) {
  return (
    <>
      <Row>
        <Toggle
          id="embed-bg"
          checked={settings.transparent}
          onChange={(v) => onChange({ transparent: v })}
          text="Прозрачный фон"
        />
      </Row>
    </>
  )
}

// БЕЙДЖ — единственная настройка экрана, которая сохраняется: она свойство формы, а не
// вставки, и действует на все вставки и на прямую ссылку разом. Переехал сюда из шторки
// оформления (решение владельца 2026-08-16).
//
// Гейт у него ДРУГОЙ природы, чем у остального оформления: публикацию он не держит, а
// срабатывает при отдаче формы. С 2026-08-27 (решение владельца) он ещё и единственный
// в кабинете, который держит сам КОНТРОЛ: снять бейдж на бесплатном тарифе нельзя —
// вместо сохранённого намерения открывается общий оверлей тарифа.
//
// Тумблер правит ЖИВОЕ свойство формы (`branding`), а не черновик схемы: на
// опубликованной форме он срабатывает сразу, поэтому строки «применится после
// следующей публикации» под ним больше нет (ADR §10, решение владельца 2026-08-28).
function BadgeToggle({ form }: { form: FormDetail }) {
  const canRemove = useFeatureAllowed('form_branding')
  const update = useUpdateBranding()
  const show = form.branding
  // Разговор о тарифе вместо отказа: общий оверлей `features/plan/PlanUpsell`.
  const [upsell, setUpsell] = useState(false)

  return (
    <Row>
      <Toggle
        id="embed-branding"
        checked={show}
        disabled={update.isPending}
        onChange={(v) => {
          // ПОПЫТКА СНЯТЬ БЕЙДЖ НА БЕСПЛАТНОМ ТАРИФЕ НИЧЕГО НЕ МЕНЯЕТ и открывает
          // оверлей с предложением (решение владельца 2026-08-27). Включить бейдж
          // обратно можно всегда — гейт стоит только на его снятии.
          if (!v && !canRemove) {
            setUpsell(true)
            return
          }
          update.mutate({ id: form.id, show: v })
        }}
        text="Брендинг Trillix"
        tip="Показывать «Сделано в Trillix» на вашей форме"
        // МЕТКА СТОИТ ВСЕГДА, а не только у бесплатного тарифа, и это не небрежность.
        // Во-первых, она называет условие, при котором настройка СРАБОТАЕТ, а не
        // запрещает её трогать: намерение сохраняется на любом тарифе, гейт стоит при
        // отдаче формы. Во-вторых, `useFeatureAllowed` отвечает «можно» на всех планах,
        // где ключ открыт (BILLING §6), и метка под условием `!canRemove` не
        // показалась бы там вообще никому. Тот же приём и по тому же доводу у карточки
        // ссылки на «Поделиться».
        pro
      />
      {update.isError && (
        <p className="text-xs text-destructive" role="alert">
          Не удалось сохранить. Если форма открыта в редакторе в другой вкладке — обновите страницу
          и попробуйте ещё раз.
        </p>
      )}
      <PlanUpsell open={upsell} onOpenChange={setUpsell} />
    </Row>
  )
}

// Строка списка настроек. Черту между строками рисует контейнер (`divide-y`), здесь
// только вертикальный воздух вокруг содержимого.
function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 py-4">{children}</div>
}

/**
 * WithUnit — единица измерения ВНУТРИ поля, у правого края.
 *
 * Не в подписи: «Ширина панели» отвечает на «что», «px» — на «в чём», и вместе они
 * читаются одной строкой, а подпись остаётся короткой. Кегль и вес у единицы общие
 * со значением — иначе «px» читается не концом строки, а меткой поверх неё.
 *
 * МЕСТО СПРАВА ДЕЛЯТ ДВОЕ: стрелки счётчика браузер рисует у правого края
 * СОДЕРЖИМОГО, то есть внутри отступа поля (`pr-9` на самом `Input`), а единица стоит
 * правее — в самом отступе. Уменьшишь `pr` — они наедут друг на друга.
 */
function WithUnit({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-base font-medium text-muted-foreground">
        {unit}
      </span>
    </div>
  )
}

// Поле с подписью над контролом. Просвет 8, а не 4: четвёрка в ритме кабинета
// означает «заголовок и его подпись», то есть склеивает две строки в одну пару, а
// подпись и поле ввода — соседи (DESIGN-SYSTEM §5).
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <>
      {/* Вес обычный, а не 600 из шкалы: рядом стоят подписи тумблеров, у них он тоже
          обычный, и полужирная строка над полем читалась бы заголовком связки — тем
          самым, который отсюда убрали. */}
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      {children}
    </>
  )
}

// ТУМБЛЕР СПРАВА, ПОДПИСЬ СЛЕВА (решение владельца 2026-08-27): все переключатели
// колонки встают в один столбец у правого края, и состояние настроек читается одним
// движением глаза сверху вниз — при тумблере слева его приходится искать за подписью
// разной длины. Пояснений под строкой нет: их работу делит подпись и сам предпросмотр
// справа, который показывает результат переключения.
function Toggle({
  id,
  checked,
  onChange,
  text,
  tip,
  pro = false,
  disabled = false,
}: {
  id: string
  checked: boolean
  onChange: (value: boolean) => void
  text: string
  /** Пояснение под значком вопроса — там, где подписи мало, а строки под ней нет. */
  tip?: string
  /** Метка платной возможности. Ничего не запирает — называет тариф (BILLING §6). */
  pro?: boolean
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id} className="font-normal">
          {text}
        </Label>
        {pro && <ProTag />}
        {tip && (
          <Tooltip>
            {/* Настоящая кнопка, а не значок: тултип обязан открываться и с
                клавиатуры, а `TooltipTrigger` вешает обработчики на то, что ему
                дали. Тип `button` — иначе внутри формы это отправка. */}
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={tip}
                className="text-muted-foreground hover:text-foreground"
              >
                <CircleHelp className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{tip}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}
