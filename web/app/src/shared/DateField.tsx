import { useState } from 'react'
import { CalendarIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { LazyCalendar } from './lazyCalendar'

// Поле даты «ГГГГ-ММ-ДД»: кнопка с датой по-русски, панель — общий календарь за
// ленивой границей (shared/lazyCalendar). Отдельным компонентом, потому что дата без
// времени нужна в двух местах расписания — исключениям и блокировкам, — а собранная
// по месту она разъехалась бы видом.
export function DateField({
  value,
  onChange,
  placeholder = 'Выберите дату',
  className,
}: {
  // Значение «ГГГГ-ММ-ДД» либо пустая строка (дату ещё не выбирали).
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // Дата разбирается с полуночью МЕСТНОГО времени браузера: `new Date('2026-09-14')`
  // без времени читается как UTC и на минусовых поясах даёт предыдущий день.
  const selected = value === '' ? undefined : new Date(`${value}T00:00`)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn('w-56 justify-start gap-2 font-normal', className)}>
          <CalendarIcon className="size-4 text-muted-foreground" />
          {selected ? (
            selected.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <LazyCalendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (!date) return
            onChange(
              `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
            )
            setOpen(false)
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  )
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
