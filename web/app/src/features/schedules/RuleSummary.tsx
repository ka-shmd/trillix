import type { Schedule } from '../../entities/schedule'
import { groupDays, NO_RULE, ruleGroups } from './weekly'

// Левая полоса поверхности «Приём»: правило словами и параметры нарезки.
//
// Мини-календаря и ближайших записей здесь нет по построению — они про даты, а у
// правила дат не бывает. Место освободилось, и занимает его то, чего на полотне не
// прочесть глазом: сколько длится приём, на сколько вперёд открыта запись и за какой
// срок до встречи записаться уже нельзя.
export function RuleSummary({ schedule }: { schedule: Schedule }) {
  const groups = ruleGroups(schedule.availability)
  const exceptions = schedule.availability.exceptions.length

  return (
    <div className="flex flex-col gap-5 text-sm">
      <div>
        <p className="font-semibold">Обычная неделя</p>
        {groups.length === 0 ? (
          <p className="mt-2 text-muted-foreground">{NO_RULE}</p>
        ) : (
          <dl className="mt-2 flex flex-col gap-1">
            {groups.map((g) => (
              <div key={g.days.join()} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{groupDays(g)}</dt>
                <dd className="text-right tabular-nums">{g.hours}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div>
        <p className="font-semibold">Нарезка</p>
        <dl className="mt-2 flex flex-col gap-1">
          <Row title="Приём" value={minutes(schedule.slotMinutes)} />
          {schedule.bufferMinutes > 0 && (
            <Row title="Перерыв" value={minutes(schedule.bufferMinutes)} />
          )}
          <Row title="Горизонт" value={days(schedule.horizonDays)} />
          {schedule.leadMinutes > 0 && (
            <Row title="Не позже чем за" value={minutes(schedule.leadMinutes)} />
          )}
          {schedule.capacity > 1 && <Row title="Мест в приёме" value={String(schedule.capacity)} />}
        </dl>
      </div>

      {/* МОСТ МЕЖДУ ПОВЕРХНОСТЯМИ. Исключения правятся на датах, и автор, стоящий на
          вкладке правила, иначе не узнал бы, что его обычная неделя где-то перебита:
          на этом экране их не видно вовсе. Числом, а не списком — список дат в полосе
          шириной в 16rem нечитаем, а вопрос здесь один: «есть или нет». */}
      {exceptions > 0 && (
        <p className="text-muted-foreground">
          Дней с особыми часами: {exceptions}. Они видны и правятся на вкладке «Календарь».
        </p>
      )}
    </div>
  )
}

function Row({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{title}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  )
}

// minutes — «90 мин» или «1 ч 30 мин». Часами, потому что упреждение задают сутками
// («не позже чем за 2 дня»), и 2880 минут в сводке не читается никак.
function minutes(total: number): string {
  if (total < 60) return `${total} мин`
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  return [
    d > 0 && `${d} ${plural(d, 'день', 'дня', 'дней')}`,
    h > 0 && `${h} ч`,
    m > 0 && `${m} мин`,
  ]
    .filter(Boolean)
    .join(' ')
}

function days(n: number): string {
  return `${n} ${plural(n, 'день', 'дня', 'дней')}`
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}
