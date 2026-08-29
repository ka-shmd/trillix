import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Clock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// Поле времени в 24 часах: кнопка со значением, по нажатию — панель с двумя
// прокручиваемыми колёсами (часы и минуты), как на телефоне.
//
// СВОЙ КОНТРОЛ, и это осознанное отступление от правила «весь кабинет на shadcn»
// (web/CLAUDE.md): тайм-пикера у shadcn/ui нет вовсе, а нативный `input type="time"`
// берёт формат из локали браузера — в русском интерфейсе автор мог увидеть «11:59 PM»,
// и задать формат нельзя ни атрибутом, ни CSS.
//
// Колесо — обычная прокрутка со snap'ом, а не своя физика: браузер уже умеет и
// инерцию, и прилипание (`snap-y snap-mandatory`), и колесо мыши, и палец. Значение
// назначает та строка, что оказалась в центре, — её же обводит неподвижная полоса.
//
// КЛАВИАТУРА РАВНОПРАВНА мыши: колесо это `listbox` с фокусом, стрелки двигают выбор
// (по кругу, 23 → 00), Home/End бросают на края. Прокручиваемая полоса без этого была
// бы органом, до которого с клавиатуры не добраться.

// Высота строки колеса. Числом, а не классом: по нему считается и прокрутка до
// выбранного, и обратный перевод «положение → значение», — три места обязаны знать
// одно и то же число.
const ROW = 36
// Строк видно пять: центральная — выбранная, по две сверху и снизу для контекста.
const VISIBLE = 5

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))

export function TimeField({
  value,
  onChange,
  disabled,
  invalid,
  className,
}: {
  // Значение «ЧЧ:ММ» либо пустая строка (время ещё не выбирали).
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [rawH = '', rawM = ''] = value === '' ? ['', ''] : value.split(':')
  const hh = pad(rawH)
  const mm = pad(rawM)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          aria-invalid={invalid}
          className={cn('w-32 justify-start gap-2 font-normal tabular-nums', className)}
        >
          <Clock className="size-4 text-muted-foreground" />
          {value === '' ? <span className="text-muted-foreground">Время</span> : `${hh}:${mm}`}
        </Button>
      </PopoverTrigger>
      {/* Панель без полей: колёса упираются в её края, как ленты, а не как два поля
          на подложке. */}
      <PopoverContent className="w-auto p-0" align="start">
        <div className="relative flex" style={{ height: ROW * VISIBLE }}>
          {/* Неподвижная полоса выбора: под ней проезжают значения, и центр перестаёт
              быть догадкой. Ниже колёс по слою, чтобы не перехватывать прокрутку. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-1 top-1/2 -translate-y-1/2 rounded-md bg-accent"
            style={{ height: ROW }}
          />
          <Wheel label="Часы" items={HOURS} value={hh} onSelect={(v) => onChange(`${v}:${mm}`)} />
          <Wheel
            label="Минуты"
            items={MINUTES}
            value={mm}
            onSelect={(v) => onChange(`${hh}:${v}`)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Wheel({
  label,
  items,
  value,
  onSelect,
}: {
  label: string
  items: string[]
  value: string
  onSelect: (value: string) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const index = Math.max(0, items.indexOf(value))

  // Открытая панель показывает выбранное В ЦЕНТРЕ, а не сверху: колесо, начатое с
  // нуля, требует прокрутить его к своему же значению.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = index * ROW
    // Только на монтирование: дальше положением управляет человек, и подкручивать
    // ленту под ним на каждый рендер значило бы драться с его пальцем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Значение назначает строка, оказавшаяся в центре. Считаем ПОСЛЕ остановки
  // (инерция прокрутки шлёт события пачкой): иначе значение прыгало бы всю дорогу, а
  // с ним и вся страница — черновик настроек считается на каждое изменение.
  const onScroll = () => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      const el = list.current
      if (!el) return
      const next = items[Math.round(el.scrollTop / ROW)]
      if (next !== undefined && next !== value) onSelect(next)
    }, 120)
  }

  const move = (to: number) => {
    const next = items[(to + items.length) % items.length]
    if (next === undefined) return
    onSelect(next)
    list.current?.scrollTo({ top: ((to + items.length) % items.length) * ROW, behavior: 'smooth' })
  }

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(index + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(index - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      move(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      move(items.length - 1)
    }
  }

  return (
    <div
      ref={list}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={keys}
      // Поля сверху и снизу ростом в две строки — чтобы первое и последнее значение
      // тоже вставали в центр, а не упирались в край ленты.
      style={{ paddingBlock: ROW * ((VISIBLE - 1) / 2) }}
      className="relative w-16 snap-y snap-mandatory overflow-y-auto rounded-md outline-none [scrollbar-width:none] focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="option"
          aria-selected={item === value}
          tabIndex={-1}
          onClick={() => move(items.indexOf(item))}
          style={{ height: ROW }}
          className={cn(
            'flex w-full snap-center items-center justify-center text-sm tabular-nums transition-colors',
            item === value ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {item}
        </button>
      ))}
    </div>
  )
}

// pad — двузначное представление сегмента. Пустая строка тоже становится «00»:
// половины времени не бывает, и наружу поле отдаёт только целое значение.
function pad(v: string): string {
  return String(Number(v || '0')).padStart(2, '0')
}
