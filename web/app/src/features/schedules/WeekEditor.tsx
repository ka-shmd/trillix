import { Copy, Plus, X } from 'lucide-react'

import {
  MAX_WINDOWS_PER_DAY,
  WEEKDAYS,
  WEEKDAY_TITLES,
  type Availability,
  type Weekday,
} from '../../entities/schedule'
import { TimeField } from '../../shared/TimeField'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  addWindow,
  copyToWorkdays,
  dayEnabled,
  dayWindows,
  removeWindow,
  setWindow,
  toggleDay,
  windowsError,
} from './weekly'

// Приём по дням недели: семь строк, в каждой тумблер и окна времени.
//
// Строка дня — ОДНА строка, пока окно одно, и растёт вниз, когда их больше: перерыв
// («10:00–13:00, 14:00–18:00») — второе окно, а не отдельная настройка. Так же это
// устроено в документе правила, и два разных представления одного и того же рано или
// поздно разъехались бы.
export function WeekEditor({
  value,
  onChange,
}: {
  value: Availability
  onChange: (next: Availability) => void
}) {
  return (
    <div className="flex flex-col divide-y">
      {WEEKDAYS.map((day) => (
        <DayRow key={day} day={day} value={value} onChange={onChange} />
      ))}
    </div>
  )
}

function DayRow({
  day,
  value,
  onChange,
}: {
  day: Weekday
  value: Availability
  onChange: (next: Availability) => void
}) {
  const windows = dayWindows(value, day)
  const on = dayEnabled(value, day)
  const error = windowsError(windows)

  return (
    // Строка дня — ГРУППА контролов одного дня, и это разметка, а не тестовый крючок:
    // без имени группы скринридер читает четыре поля времени подряд, не сообщая, к
    // какому дню они относятся.
    <div
      role="group"
      aria-label={WEEKDAY_TITLES[day]}
      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-4"
    >
      <label className="flex w-48 shrink-0 items-center gap-3 pt-1.5">
        <Switch
          checked={on}
          onCheckedChange={(next) => onChange(toggleDay(value, day, next))}
          aria-label={WEEKDAY_TITLES[day]}
        />
        <span className={on ? 'text-sm font-medium' : 'text-sm text-muted-foreground'}>
          {WEEKDAY_TITLES[day]}
        </span>
      </label>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {!on && <p className="pt-2 text-sm text-muted-foreground">Не принимаю</p>}
        {on &&
          windows.map((w, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <TimeField
                value={w.from}
                invalid={error !== null}
                onChange={(from) => onChange(setWindow(value, day, i, { ...w, from }))}
              />
              <span className="text-muted-foreground">—</span>
              <TimeField
                value={w.to}
                invalid={error !== null}
                onChange={(to) => onChange(setWindow(value, day, i, { ...w, to }))}
              />
              {/* Убрать окно можно всегда, включая последнее: день без окон — это и
                  есть выключенный день, и запрет означал бы, что выключают его двумя
                  разными способами. */}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Убрать окно"
                onClick={() => onChange(removeWindow(value, day, i))}
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
        {on && (
          <div className="flex flex-wrap gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={windows.length >= MAX_WINDOWS_PER_DAY}
              onClick={() => onChange(addWindow(value, day))}
            >
              <Plus className="size-4" />
              Окно
            </Button>
            {/* Без этой кнопки автор заполняет одно и то же пять раз. Выходные она
                не трогает: их правят отдельно, и чаще всего они пустые. */}
            <Button variant="ghost" size="sm" onClick={() => onChange(copyToWorkdays(value, day))}>
              <Copy className="size-4" />
              На все будни
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
