import { Link } from '@tanstack/react-router'

import { type ScheduleListItem } from '../../entities/schedule'
import { weekSummary } from './weekly'
import { bookingTime, pluralBookings, zoneShort } from './scheduleFormat'
import { ScheduleActionsMenu } from './ScheduleActionsMenu'
import { cn } from '@/lib/utils'

// Раскладка строки и шапки колонок — ОДНА константа на два компонента: разъедься
// они хоть на четверть колонки, числа перестали бы стоять под своими подписями, и
// заметить это можно было бы только глазами. Тот же приём, что в списке форм.
//
// До `md` числовые колонки не рисуются вовсе, а не жмутся: пять правых колонок на
// 375 px оставляют названию сорок пикселей. Вместо них у названия появляется вторая
// строка со сводкой — те же числа словами.
const GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 md:grid-cols-[minmax(0,1fr)_4.25rem_3rem_3.5rem_4.5rem_7rem_2.5rem]'

// Шапка колонок. Отдельным рядом, а не первой строкой таблицы: `Table` здесь не
// взят намеренно — строка обязана быть ссылкой целиком, а `<tr>` ссылкой не
// становится (обернуть `<td>` в `<a>` нельзя, разметка недопустима).
export function ScheduleRowsHeader() {
  return (
    <div
      className={cn(GRID, 'px-3 pb-1.5 text-xs text-muted-foreground')}
      // Подписи колонок дублируют то, что уже сказано в каждой строке словами
      // (приём 60 минут, 3 записи впереди), поэтому скринридеру они не нужны — а как
      // отдельная строка списка читались бы расписанием без названия.
      aria-hidden="true"
    >
      <span>Название</span>
      <span className="hidden text-center md:block">Приём</span>
      <span className="hidden text-center md:block">Мест</span>
      <span className="hidden text-center md:block">Формы</span>
      <span className="hidden text-center md:block">Впереди</span>
      <span className="hidden text-center md:block">Ближайшая</span>
      <span />
    </div>
  )
}

// ScheduleRow — строка списка расписаний. Нажимается ЦЕЛИКОМ: ссылка названия
// растянута псевдоэлементом на всю строку (`after:absolute after:inset-0`), поэтому
// ссылка в разметке остаётся одна — со своим адресом, средним кликом и контекстным
// меню браузера. Меню действий стоит выше по слою (`relative z-10`), иначе
// накрывающий слой съедал бы клики по нему.
export function ScheduleRow({
  schedule,
  workspaceSlug,
}: {
  schedule: ScheduleListItem
  workspaceSlug: string
}) {
  // Пустое недельное правило — состояние, которое молча отказывает ВСЕМ: свободного
  // времени у такого расписания нет ни на один день, и форма с ним не покажет
  // респонденту ни одного слота. Метка жёлтая, потому что это предупреждение
  // (DESIGN-SYSTEM §6), а не статус.
  const idle = Object.values(schedule.availability.weekly).every((w) => w.length === 0)

  return (
    <div
      data-slot="schedule-row"
      className={cn(
        GRID,
        'group relative rounded-md px-3 py-2.5 transition-colors',
        'hover:bg-accent/60 has-[a:focus-visible]:bg-accent/60',
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to="/w/$workspaceSlug/schedules/$scheduleId"
            params={{ workspaceSlug, scheduleId: schedule.id }}
            className="min-w-0 truncate text-sm font-medium after:absolute after:inset-0 after:rounded-md"
          >
            {schedule.name}
          </Link>
          {idle && (
            <span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-xs whitespace-nowrap">
              приём не ведётся
            </span>
          )}
          {/* Ноль в колонке «Формы» — число среди чисел, и как новость он не
              читается. А новость крупная: расписание, к которому не подключена ни
              одна форма, наружу не выходит совсем — записаться в него неоткуда.
              Метка приглушённая, а не жёлтая: у только что заведённого расписания
              форм и не бывает, и предупреждать о нормальном ходе дел не о чем. */}
          {schedule.formsCount === 0 && (
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground">
              не подключено к форме
            </span>
          )}
        </div>
        {/* Часы недели и город пояса. У расписания без часов сводка сказала бы
            «Приём не ведётся» второй раз подряд — там остаётся один пояс. */}
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {idle
            ? zoneShort(schedule.timezone)
            : `${weekSummary(schedule.availability)} · ${zoneShort(schedule.timezone)}`}
          {/* Сводка вместо колонок на узком экране — те же числа, что справа на
              широком. */}
          <span className="md:hidden">
            {` · приём ${schedule.slotMinutes} мин · ${schedule.upcomingCount} ${pluralBookings(schedule.upcomingCount)} впереди`}
          </span>
        </p>
      </div>

      <span className="hidden text-center text-sm text-muted-foreground tabular-nums md:block">
        {schedule.slotMinutes} мин
      </span>
      <span className="hidden text-center text-sm text-muted-foreground tabular-nums md:block">
        {schedule.capacity}
      </span>
      <span className="hidden text-center text-sm text-muted-foreground tabular-nums md:block">
        {schedule.formsCount}
      </span>
      <span className="hidden text-center text-sm tabular-nums md:block">
        {schedule.upcomingCount === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          schedule.upcomingCount
        )}
      </span>
      <span className="hidden text-center text-xs text-muted-foreground md:block">
        {schedule.nextBookingAt ? bookingTime(schedule.nextBookingAt, schedule.timezone) : '—'}
      </span>

      {/* Действия видны ВСЕГДА, а не по наведению: на тач-экране наведения не
          наступает никогда, и спрятанные под него действия недоступны совсем. */}
      <div className="relative z-10 flex items-center justify-end">
        <ScheduleActionsMenu schedule={schedule} />
      </div>
    </div>
  )
}
