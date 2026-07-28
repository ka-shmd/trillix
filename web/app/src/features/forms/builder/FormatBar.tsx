import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Bold, Italic, Link2, Link2Off, Strikethrough, Underline } from 'lucide-react'
import { type Mark, isHttpUrl } from '@entities/formSchema'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ColorPicker } from './ColorPicker'

// Панель форматирования (фаза 14, этап 14.4, §3.3 `docs/DESIGN-rich-text.md`): всплывает
// над непустым выделением внутри текстовой строки полотна.
//
// Два правила, нарушение которых ломает панель ТИХО:
//
//   1. Панель НЕ забирает фокус. Каждый её элемент гасит `mousedown`: ушедший из строки
//      фокус схлопывает выделение, и кнопка применяет марку к пустоте. Симптом
//      обманчив — «кнопка не работает», хотя нажатие дошло.
//   2. Панель порталится и не занимает места в потоке. Урок TD-22 в силе: контрол,
//      который появляется по фокусу и при этом стоит в потоке, схлопывается на
//      `mousedown`, всё ниже уезжает вверх, и `mouseup` приходит уже мимо цели.
//
// Исключение из правила 1 — поле адреса ссылки: оно фокус берёт НАМЕРЕННО. Это
// безопасно, потому что диапазон выделения к тому моменту уже зафиксирован в состоянии
// строки (`sel`), и схлопывание живого выделения на него не влияет.

export interface FormatBarProps {
  // Экранный прямоугольник выделения — панель встаёт над ним.
  rect: DOMRect
  // Какие булевы марки стоят на ВСЁМ выделении (кнопка показывается нажатой).
  active: ReadonlySet<Mark>
  // Текущая ссылка выделения, если она одна на весь диапазон.
  href?: string
  onToggleMark: (m: Mark) => void
  // undefined — «убрать цвет»: спан теряет поле, а не получает чёрный.
  onColor: (color: string | undefined) => void
  onBg: (bg: string | undefined) => void
  onLink: (href: string | undefined) => void
  // Вернуть фокус и выделение в строку. Нужен выборщику цвета: он единственный контрол
  // панели, который фокус забирает не на мгновение, а на всё время выбора.
  onReturnFocus: () => void
  // Открыть поле адреса сразу (жест Mod+K, а не клик по кнопке).
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

const MARK_BUTTONS: ReadonlyArray<[Mark, typeof Bold, string]> = [
  ['b', Bold, 'Жирный'],
  ['i', Italic, 'Курсив'],
  ['u', Underline, 'Подчёркнутый'],
  ['s', Strikethrough, 'Зачёркнутый'],
]

// Панель встаёт НАД выделением; у самого верха окна места нет — тогда под ним. Прижать
// её к потолку (`Math.max(8, …)`, как было) значило бы положить панель поверх текста,
// который она форматирует.
const BAR_H = 44

export function FormatBar({
  rect,
  active,
  href,
  onToggleMark,
  onColor,
  onBg,
  onLink,
  onReturnFocus,
  linkOpen,
  onLinkOpenChange,
}: FormatBarProps) {
  // keepFocus — единственная причина, по которой панель вообще работает (правило 1).
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const ref = useRef<HTMLDivElement>(null)

  // Правый край — единственная координата, которую нельзя посчитать заранее: ширина
  // панели зависит от того, открыто ли поле адреса. Правим её после раскладки и прямо
  // в DOM: состояние здесь означало бы второй рендер на каждое движение выделения, а
  // считать нечего — панель уже измерена браузером.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const room = el.ownerDocument.documentElement.clientWidth - el.offsetWidth - 8
    el.style.left = `${Math.max(8, Math.min(rect.left, room))}px`
  })

  return createPortal(
    <div
      ref={ref}
      data-format-bar=""
      role="toolbar"
      aria-label="Форматирование текста"
      // fixed + координаты выделения: панель вне потока строки (правило 2).
      style={{
        position: 'fixed',
        left: Math.max(8, rect.left),
        top: rect.top - BAR_H >= 8 ? rect.top - BAR_H : rect.bottom + 8,
        zIndex: 50,
      }}
      className="flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
      onMouseDown={keepFocus}
    >
      {linkOpen ? (
        <LinkEditor
          href={href}
          onSubmit={(next) => {
            onLink(next)
            onLinkOpenChange(false)
          }}
          onCancel={() => onLinkOpenChange(false)}
        />
      ) : (
        <>
          {MARK_BUTTONS.map(([mark, Icon, label]) => (
            <button
              key={mark}
              type="button"
              aria-label={label}
              aria-pressed={active.has(mark)}
              className={`flex size-7 items-center justify-center rounded hover:bg-muted ${
                active.has(mark) ? 'bg-muted text-foreground' : 'text-muted-foreground'
              }`}
              onClick={() => onToggleMark(mark)}
            >
              <Icon className="size-4" />
            </button>
          ))}

          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

          <ColorButton
            label="Цвет текста"
            picker="color"
            initial="#1d4ed8"
            swatches={TEXT_SWATCHES}
            onPick={onColor}
            onReturnFocus={onReturnFocus}
          >
            <span aria-hidden="true" className="leading-none font-semibold">
              A
            </span>
            <span aria-hidden="true" className="mt-px h-1 w-4 rounded-full bg-foreground" />
          </ColorButton>
          <ColorButton
            label="Цвет фона"
            picker="bg"
            initial="#fef08a"
            swatches={BG_SWATCHES}
            onPick={onBg}
            onReturnFocus={onReturnFocus}
          >
            <span
              aria-hidden="true"
              className="rounded-sm bg-muted px-1 leading-none font-semibold"
            >
              A
            </span>
          </ColorButton>

          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

          <button
            type="button"
            aria-label="Ссылка"
            aria-pressed={!!href}
            className={`flex size-7 items-center justify-center rounded hover:bg-muted ${
              href ? 'bg-muted text-foreground' : 'text-muted-foreground'
            }`}
            onClick={() => onLinkOpenChange(true)}
          >
            <Link2 className="size-4" />
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}

// Палитры готовых цветов. Абсолютные (ADR §10: публичная форма всегда светлая), поэтому
// подобраны против БЕЛОГО холста формы, а не против темы кабинета: текст — насыщенные,
// фон — пастель под маркер.
const TEXT_SWATCHES: readonly string[] = [
  '#111827',
  '#374151',
  '#6b7280',
  '#9ca3af',
  '#b91c1c',
  '#c2410c',
  '#a16207',
  '#4d7c0f',
  '#15803d',
  '#0f766e',
  '#0369a1',
  '#1d4ed8',
  '#4338ca',
  '#7e22ce',
  '#a21caf',
  '#be185d',
]

const BG_SWATCHES: readonly string[] = [
  '#fef08a',
  '#fed7aa',
  '#fecaca',
  '#fbcfe8',
  '#e9d5ff',
  '#c7d2fe',
  '#bfdbfe',
  '#a5f3fc',
  '#99f6e4',
  '#bbf7d0',
  '#d9f99d',
  '#fde68a',
  '#f3f4f6',
  '#e5e7eb',
  '#d1d5db',
  '#ffffff',
]

// ColorButton — кнопка панели и поповер с выборщиком (shadcn Popover + свой
// `ColorPicker`, см. его шапку о том, почему свой, а не библиотека).
//
// Чего тут больше нет: нативного `<input type="color">` под меткой `<label>`. С ним
// палитра не открывалась ВООБЩЕ. Метка обещает переслать клик контролу внутри, но
// пересылка происходит на `click`, а ломалось раньше — на `mousedown`: метка фокус не
// принимает, панель живёт в портале на `document.body`, фокусируемых предков у неё нет,
// и фокус уходил из строки В НИКУДА (`relatedTarget: null`). Строка на своём blur
// закрывала панель, портал исчезал внутри того же `mousedown`, и пересылать `click` было
// уже некуда. Ровно грабли TD-22, вид сбоку: «кнопка нажимается и молчит».
//
// Три вещи, на которых поповер держится, — все про правило 1 (панель не забирает фокус):
//
//   • `onOpenAutoFocus` погашен: Radix по умолчанию уводит фокус в содержимое сразу на
//     открытии, а это схлопнуло бы выделение до того, как автор выбрал цвет.
//   • `onCloseAutoFocus` погашен И возвращает фокус в СТРОКУ, а не на кнопку панели
//     (`onReturnFocus`). Иначе после выбора цвета каретка оставалась бы неизвестно где.
//   • Содержимое носит метку `data-format-bar`, хотя панели не принадлежит: оно
//     порталится отдельно, а строка и слушатель «клик мимо» опознают своё по этой метке.
//     Без неё уход фокуса в поле hex читался бы как уход наружу, и панель закрывалась бы
//     прямо под курсором.
function ColorButton({
  label,
  picker,
  initial,
  swatches,
  onPick,
  onReturnFocus,
  children,
}: {
  label: string
  // Метка поповера для тестов: у кнопки панели уже есть aria-label, дублировать его на
  // содержимом нельзя.
  picker: string
  // С какого цвета открывается выборщик. Текущий цвет выделения сюда не приходит —
  // модель его не считает (осознанная граница, см. отчёт этапа).
  initial: string
  swatches: readonly string[]
  onPick: (color: string | undefined) => void
  onReturnFocus: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={`flex size-7 flex-col items-center justify-center rounded text-xs hover:bg-muted ${
            open ? 'bg-muted text-foreground' : 'text-muted-foreground'
          }`}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-format-bar=""
        data-color-popover={picker}
        align="start"
        sideOffset={6}
        className="w-auto p-2"
        // Тот же гард, что у самой панели, и по той же причине: клик по любому месту
        // поповера, у которого нет своего обработчика (поля между контролами, отступы),
        // иначе уводит фокус из строки в никуда — и панель схлопывается вместе с
        // выборщиком. Исключение одно — поле hex, оно всплытие останавливает.
        onMouseDown={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onReturnFocus()
        }}
      >
        <ColorPicker
          initial={initial}
          swatches={swatches}
          removeLabel={`Убрать ${label.toLowerCase()}`}
          // Цвет применяется НЕПРЕРЫВНО, пока автор возит мышью: выделение под поповером
          // перекрашивается сразу, и выбор идёт по результату, а не вслепую. Дробить
          // историю отмены это не должно — правки текста коалесцируются по тегу блока.
          onChange={onPick}
          onRemove={() => {
            onPick(undefined)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

// LinkEditor — поле адреса. Отдельный компонент, а не ветка внутри панели, по причине
// правила React: начальное значение черновика приходит из пропа, и синхронизировать его
// эффектом (`setState` внутри `useEffect`) нельзя — это каскадные ре-рендеры. Компонент
// монтируется вместе с открытием поля, поэтому `useState` берёт значение сам.
function LinkEditor({
  href,
  onSubmit,
  onCancel,
}: {
  href?: string
  onSubmit: (href: string | undefined) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(href ?? '')
  const valid = draft === '' || isHttpUrl(draft)
  const submit = () => {
    if (!valid) return
    onSubmit(draft === '' ? undefined : draft)
  }

  return (
    <>
      <Input
        // Автофокус — атрибутом, а не эффектом: поле живёт ровно пока открыто, и это
        // единственный момент, когда фокус ему нужен. Исключение из «панель не забирает
        // фокус» осознанное — диапазон уже зафиксирован в состоянии строки.
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        placeholder="https://example.com"
        aria-label="Адрес ссылки"
        aria-invalid={!valid || undefined}
        className="h-7 w-64 text-xs"
        onMouseDown={(e) => e.stopPropagation()}
      />
      <Button size="sm" className="h-7" disabled={!valid} onClick={submit}>
        Применить
      </Button>
      {href && (
        <button
          type="button"
          aria-label="Убрать ссылку"
          className="flex size-7 items-center justify-center rounded hover:bg-muted"
          onClick={() => onSubmit(undefined)}
        >
          <Link2Off className="size-4" />
        </button>
      )}
    </>
  )
}
