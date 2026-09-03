import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarOff, Plus, X } from 'lucide-react'

import { MAX_SCHEDULE_NOTE_LEN, type ScheduleBlock } from '../../entities/schedule'
import { blocksQueryOptions, useAddBlock, useRemoveBlock } from '../../shared/schedules/queries'
import { DateField } from '../../shared/DateField'
import { TimeField } from '../../shared/TimeField'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { humanError } from '../../shared/api/errors'
import { LOCALE } from '../../shared/format'
import { zonedToUTC } from './zone'

// Занятое время, закрытое руками: отпуск, свои дела, «сегодня обед на час позже».
//
// Раздел нужен ровно потому, что чужой календарь нашу занятость НЕ закрывает
// (design/booking.md §4.1): личная встреча, поставленная автором в Яндексе, форму не
// закроет — закрывает её эта запись. Говорим это прямо: узнавать такое опытным путём
// автору придётся на живом клиенте.
export function BlocksSection({ scheduleId, timezone }: { scheduleId: string; timezone: string }) {
  const blocks = useQuery(blocksQueryOptions(scheduleId))
  const add = useAddBlock(scheduleId)
  const remove = useRemoveBlock(scheduleId)
  const [draft, setDraft] = useState({ date: '', from: '', to: '', note: '' })
  const ready = draft.date !== '' && draft.from !== '' && draft.to !== '' && draft.from < draft.to

  function submit() {
    if (!ready) return
    add.mutate(
      {
        // Введённое время — время РАСПИСАНИЯ, а не устройства автора (zone.ts):
        // закрывает он свой рабочий час, а не час на часах ноутбука в поездке.
        startsAt: zonedToUTC(draft.date, draft.from, timezone),
        endsAt: zonedToUTC(draft.date, draft.to, timezone),
        note: draft.note,
      },
      { onSuccess: () => setDraft({ date: '', from: '', to: '', note: '' }) },
    )
  }

  return (
    <Section
      title="Занятое время"
      description={`Личные дела в вашем календаре нашу форму не закрывают — закрывает эта запись. Время — в поясе расписания (${timezone}).`}
    >
      {blocks.isPending && <LoadingRows rows={2} />}
      {blocks.isError && (
        <ErrorState
          title="Не удалось загрузить занятое время."
          onRetry={() => void blocks.refetch()}
          retryLabel="Повторить"
        />
      )}

      {blocks.data && blocks.data.length === 0 && (
        <EmptyState
          icon={CalendarOff}
          title="Пока ничего не закрыто"
          description="Отпуск или встречу вне формы отметьте здесь — на это время записаться будет нельзя."
        />
      )}

      {blocks.data && blocks.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {blocks.data.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">{blockRange(b, timezone)}</p>
                {b.note && <p className="truncate text-sm text-muted-foreground">{b.note}</p>}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Снять"
                disabled={remove.isPending}
                onClick={() => remove.mutate(b.id)}
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <DateField value={draft.date} onChange={(date) => setDraft((d) => ({ ...d, date }))} />
          <TimeField value={draft.from} onChange={(from) => setDraft((d) => ({ ...d, from }))} />
          <span className="text-muted-foreground">—</span>
          <TimeField value={draft.to} onChange={(to) => setDraft((d) => ({ ...d, to }))} />
          <Input
            className="w-56"
            placeholder="Причина (необязательно)"
            maxLength={MAX_SCHEDULE_NOTE_LEN}
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          />
          <Button variant="outline" disabled={!ready || add.isPending} onClick={submit}>
            <Plus className="size-4" />
            Закрыть время
          </Button>
        </div>
        {add.isError && (
          <p role="alert" className="text-sm text-destructive">
            {humanError(add.error)}
          </p>
        )}
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            {humanError(remove.error)}
          </p>
        )}
      </div>
    </Section>
  )
}

// Показ — в поясе РАСПИСАНИЯ, тем же, каким блокировка вводилась: прочитай её
// поясом браузера, и автор в поездке увидел бы «07:00 — 08:00» там, где закрывал
// десять утра.
function blockRange(b: ScheduleBlock, timezone: string): string {
  const from = new Date(b.startsAt)
  const to = new Date(b.endsAt)
  const dayOpts = { timeZone: timezone, day: 'numeric', month: 'long' } as const
  const timeOpts = { timeZone: timezone, hour: '2-digit', minute: '2-digit' } as const
  const day = from.toLocaleDateString(LOCALE, dayOpts)
  const time = (d: Date) => d.toLocaleTimeString(LOCALE, timeOpts)
  // Блокировка через полночь — редкость (отпуск), но она бывает, и «14 сентября,
  // 22:00 — 06:00» без второй даты читалось бы как ошибка. Сутки считаются в поясе
  // расписания, поэтому сравниваются подписи дней, а не Date.toDateString().
  const toDay = to.toLocaleDateString(LOCALE, dayOpts)
  if (day === toDay) return `${day}, ${time(from)} — ${time(to)}`
  return `${day}, ${time(from)} — ${toDay}, ${time(to)}`
}
