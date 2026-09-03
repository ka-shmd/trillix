import { useState } from 'react'
import { Plus, X } from 'lucide-react'

import {
  MAX_SCHEDULE_EXCEPTIONS,
  type Availability,
  type ScheduleException,
} from '../../entities/schedule'
import { DateField } from '../../shared/DateField'
import { TimeField } from '../../shared/TimeField'
import { Button } from '@/components/ui/button'
import { EmptyState } from '../../shared/page/states'
import { windowsError } from './weekly'

// Исключения по датам: «14 сентября не принимаю» и «20-го только с 10 до 12».
//
// ИСКЛЮЧЕНИЕ ПЕРЕБИВАЕТ ДЕНЬ ЦЕЛИКОМ, а не дополняет его, — поэтому у строки два
// состояния, «не принимаю» и список окон, а не «плюс к обычному дню». Иначе «в этот
// день принимаю только два часа» было бы невыразимо.
export function ExceptionsEditor({
  value,
  onChange,
}: {
  value: Availability
  onChange: (next: Availability) => void
}) {
  const [adding, setAdding] = useState('')
  const exceptions = value.exceptions

  function setExceptions(next: ScheduleException[]) {
    // Порядок по дате: список читается как календарь, а не как история правок.
    onChange({ ...value, exceptions: [...next].sort((a, b) => a.date.localeCompare(b.date)) })
  }

  function add(date: string) {
    setAdding('')
    if (date === '' || exceptions.some((e) => e.date === date)) return
    setExceptions([...exceptions, { date, windows: [] }])
  }

  return (
    <div className="flex flex-col gap-3">
      {exceptions.length === 0 && (
        <EmptyState
          title="Исключений нет"
          description="Отпуск, праздник или день с укороченным приёмом — здесь они перебивают обычное расписание."
        />
      )}

      {exceptions.map((ex, index) => (
        <ExceptionRow
          key={ex.date}
          exception={ex}
          onChange={(next) => setExceptions(exceptions.map((e, i) => (i === index ? next : e)))}
          onRemove={() => setExceptions(exceptions.filter((_, i) => i !== index))}
        />
      ))}

      {exceptions.length < MAX_SCHEDULE_EXCEPTIONS && (
        <div className="flex flex-wrap items-center gap-2">
          <DateField value={adding} onChange={add} placeholder="Добавить дату" />
        </div>
      )}
    </div>
  )
}

function ExceptionRow({
  exception,
  onChange,
  onRemove,
}: {
  exception: ScheduleException
  onChange: (next: ScheduleException) => void
  onRemove: () => void
}) {
  const error = windowsError(exception.windows)
  const closed = exception.windows.length === 0

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-base font-semibold">
          {new Date(`${exception.date}T00:00`).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </span>
        <Button variant="ghost" size="icon" aria-label="Убрать исключение" onClick={onRemove}>
          <X className="size-4" />
        </Button>
      </div>

      {closed && <p className="text-sm text-muted-foreground">В этот день не принимаю</p>}

      {exception.windows.map((w, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <TimeField
            value={w.from}
            invalid={error !== null}
            onChange={(from) =>
              onChange({
                ...exception,
                windows: exception.windows.map((x, j) => (j === i ? { ...x, from } : x)),
              })
            }
          />
          <span className="text-muted-foreground">—</span>
          <TimeField
            value={w.to}
            invalid={error !== null}
            onChange={(to) =>
              onChange({
                ...exception,
                windows: exception.windows.map((x, j) => (j === i ? { ...x, to } : x)),
              })
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Убрать окно"
            onClick={() =>
              onChange({ ...exception, windows: exception.windows.filter((_, j) => j !== i) })
            }
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({
              ...exception,
              windows: [...exception.windows, { from: '10:00', to: '12:00' }],
            })
          }
        >
          <Plus className="size-4" />
          Окно приёма
        </Button>
      </div>
    </div>
  )
}
