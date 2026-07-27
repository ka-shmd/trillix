import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bold, Italic, Link2, Link2Off, Strikethrough, Underline } from 'lucide-react'
import { type Mark, isHttpUrl } from '@entities/formSchema'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

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
  onColor: (color: string) => void
  onBg: (bg: string) => void
  onLink: (href: string | undefined) => void
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

export function FormatBar({
  rect,
  active,
  href,
  onToggleMark,
  onColor,
  onBg,
  onLink,
  linkOpen,
  onLinkOpenChange,
}: FormatBarProps) {
  // keepFocus — единственная причина, по которой панель вообще работает (правило 1).
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  // ownFocus — исключение из правила 1 для контролов, которым фокус НУЖЕН: поле адреса
  // и нативные выборщики цвета. `stopPropagation`, а не отсутствие гарда: гард висит на
  // контейнере, и без остановки всплытия его `preventDefault` отменил бы у выборщика
  // цвета само открытие (браузер открывает палитру действием по умолчанию на
  // mousedown) — кнопка выглядела бы рабочей и молчала.
  //
  // Схлопывание живого выделения здесь безвредно: диапазон уже лежит в состоянии
  // строки, и команды форматирования читают именно его.
  const ownFocus = (e: React.MouseEvent) => e.stopPropagation()

  return createPortal(
    <div
      data-format-bar=""
      role="toolbar"
      aria-label="Форматирование текста"
      // fixed + координаты выделения: панель вне потока строки (правило 2).
      style={{
        position: 'fixed',
        left: Math.max(8, rect.left),
        top: Math.max(8, rect.top - 44),
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

          {/* Нативный <input type="color"> — осознанное отступление от «только shadcn»
              (web/CLAUDE.md): своего выборщика цвета в shadcn нет, а системный
              объективно лучше рукописного — та же причина, что у мобильного
              date-picker. Побочно он отдаёт ровно `#rrggbb` в нижнем регистре, то есть
              формат, который требует валидатор схемы (ADR §10). */}
          <label
            className="flex size-7 cursor-pointer items-center justify-center rounded text-xs hover:bg-muted"
            title="Цвет текста"
            onMouseDown={ownFocus}
          >
            <span aria-hidden="true">A</span>
            <input
              type="color"
              aria-label="Цвет текста"
              className="sr-only"
              onMouseDown={ownFocus}
              onChange={(e) => onColor(e.target.value)}
            />
          </label>
          <label
            className="flex size-7 cursor-pointer items-center justify-center rounded text-xs hover:bg-muted"
            title="Цвет фона"
            onMouseDown={ownFocus}
          >
            <span aria-hidden="true" className="rounded-sm bg-muted px-1">
              A
            </span>
            <input
              type="color"
              aria-label="Цвет фона"
              className="sr-only"
              onMouseDown={ownFocus}
              onChange={(e) => onBg(e.target.value)}
            />
          </label>

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
