import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarOff, Plus, X } from 'lucide-react'

import { MAX_SCHEDULE_NOTE_LEN, type ScheduleBlock } from '../../entities/schedule'
import { blocksQueryOptions, useAddBlock, useRemoveBlock } from './queries'
import { DateField } from '../../shared/DateField'
import { TimeField } from '../../shared/TimeField'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { humanError } from '../../shared/api/errors'

// Занятое время, закрытое руками: отпуск, свои дела, «сегодня обед на час позже».
//
// Раздел нужен ровно потому, что чужой календарь нашу занятость НЕ закрывает
// (design/booking.md §4.1): личная встреча, поставленная автором в Яндексе, форму не
// закроет — закрывает её эта запись. Говорим это прямо: узнавать такое опытным путём
// автору придётся на живом клиенте.
export function BlocksSection({ scheduleId }: { scheduleId: string }) {
  const blocks = useQuery(blocksQueryOptions(scheduleId))
  const add = useAddBlock(scheduleId)
  const remove = useRemoveBlock(scheduleId)
  const [draft, setDraft] = useState({ date: '', from: '', to: '', note: '' })
  const ready = draft.date !== '' && draft.from !== '' && draft.to !== '' && draft.from < draft.to

  function submit() {
    if (!ready) return
    add.mutate(
      {
        // Время местное для БРАУЗЕРА автора — то же, что он видит в поле. В UTC его
        // переводит `Date`, а сервер хранит точку на оси времени.
        startsAt: new Date(`${draft.date}T${draft.from}`).toISOString(),
        endsAt: new Date(`${draft.date}T${draft.to}`).toISOString(),
        note: draft.note,
      },
      { onSuccess: () => setDraft({ date: '', from: '', to: '', note: '' }) },
    )
  }

  return (
    <Section
      title="Занятое время"
      description="Личные дела в вашем календаре нашу форму не закрывают — закрывает эта запись."
    >
      {blocks.isPending && <LoadingRows rows={2} />}
      {blocks.isError && (
        <ErrorState title="Не удалось загрузить занятое время." onRetry={() => void blocks.refetch()} retryLabel="Повторить" />
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
            <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">{blockRange(b)}</p>
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

function blockRange(b: ScheduleBlock): string {
  const from = new Date(b.startsAt)
  const to = new Date(b.endsAt)
  const day = from.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  const time = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  // Блокировка через полночь — редкость (отпуск), но она бывает, и «14 сентября,
  // 22:00 — 06:00» без второй даты читалось бы как ошибка.
  const sameDay = from.toDateString() === to.toDateString()
  if (sameDay) return `${day}, ${time(from)} — ${time(to)}`
  const toDay = to.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  return `${day}, ${time(from)} — ${toDay}, ${time(to)}`
}
