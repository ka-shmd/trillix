import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { visitInsightsQueryOptions } from '../../features/insights/queries'
import { submissionsCountQueryOptions } from '../../features/submissions/queries'
import { periodLabels, periodSchema, type Period } from '../../shared/period'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Раздел «Аналитика» (/forms/$slug/insights): оболочка вкладок «Сводка» и «Отвалы»
// (спека design/analytics-tally.md §3). Держит две общие вещи — окно наблюдения и
// полосу карточек: они одинаковы на всех вкладках, и дублировать их на каждой
// значило бы получить три разных периода на одном экране.
//
// Период живёт в search-параметре, а не в стейте: иначе ссылка «посмотри на это»
// открывает у получателя другое окно, чем видел отправитель.
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights')({
  validateSearch: (search) => ({ period: periodSchema.parse(search.period) }),
  component: InsightsLayout,
})

function InsightsLayout() {
  const { slug } = Route.useParams()
  const { period } = Route.useSearch()

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <InsightsTabs slug={slug} period={period} />
        <PeriodSelect />
      </div>
      <Cards slug={slug} period={period} />
      <Outlet />
    </>
  )
}

// Вкладки — настоящие ссылки (навигация, а не переключатель), как и разделы формы
// на оболочке _manage: средний клик и «Назад» обязаны работать. Взаимоисключающие
// наборы классов разведены по activeProps/inactiveProps — смешивать их нельзя
// (у Tailwind-утилит одинаковая специфичность, побеждает порядок в сгенерированном
// CSS, а не в строке className).
function InsightsTabs({ slug, period }: { slug: string; period: Period }) {
  const base = 'rounded-full px-3 py-1.5 text-sm transition-colors'
  const active = { className: 'bg-foreground font-medium text-background' }
  const inactive = { className: 'text-muted-foreground hover:bg-muted hover:text-foreground' }

  return (
    <nav className="flex gap-1" aria-label="Разделы аналитики">
      <Link
        to="/forms/$slug/insights/answers"
        params={{ slug }}
        search={{ period }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Сводка
      </Link>
      <Link
        to="/forms/$slug/insights/visits"
        params={{ slug }}
        search={{ period }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Визиты
      </Link>
      <Link
        to="/forms/$slug/insights/drop-offs"
        params={{ slug }}
        search={{ period }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Отвалы
      </Link>
    </nav>
  )
}

function PeriodSelect() {
  const navigate = Route.useNavigate()
  const { period } = Route.useSearch()

  return (
    <Select
      value={period}
      onValueChange={(value) =>
        void navigate({ search: (prev) => ({ ...prev, period: periodSchema.parse(value) }) })
      }
    >
      <SelectTrigger className="w-[150px]" aria-label="Период">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(periodLabels).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Полоса карточек. Числа приезжают ДВУМЯ запросами, и это не оптимизационный
// недосмотр: визиты и ответы — независимые множества из разных модулей
// (docs/ANALYTICS.md §1), а сведение их в один ответ рано или поздно кончилось бы
// делением одного на другое.
function Cards({ slug, period }: { slug: string; period: Period }) {
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const visits = useQuery({
    ...visitInsightsQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })
  const answers = useQuery({
    ...submissionsCountQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })

  return (
    <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card title="Визиты" value={visits.data?.visits} pending={visits.isPending} />
      <Card title="Ответы" value={answers.data?.submissions} pending={answers.isPending} />
      <Card title="Уникальные" value={visits.data?.uniqueVisitors} pending={visits.isPending} />
      <DurationCard data={visits.data} pending={visits.isPending} />
    </div>
  )
}

function Card({
  title,
  value,
  pending,
}: {
  title: string
  value: number | string | undefined
  pending: boolean
}) {
  return (
    <article className="rounded-lg border p-4">
      <h2 className="text-sm text-muted-foreground">{title}</h2>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {pending ? <span className="text-muted-foreground">…</span> : (value ?? '—')}
      </p>
    </article>
  )
}

// Длительность визита. «Нет данных» и «ноль секунд» — разные новости, поэтому при
// пустом знаменателе (ни один визит не измерен) рисуется прочерк, а не ноль.
// Границы метрики на экран НЕ выносятся: владельцу формы они не адресованы, их
// место — в docs/ANALYTICS.md §6.
function DurationCard({
  data,
  pending,
}: {
  data: { timedVisits: number; medianDurationSec: number } | undefined
  pending: boolean
}) {
  const measured = data !== undefined && data.timedVisits > 0
  return (
    <Card
      title="Длительность визита"
      value={measured ? formatDuration(data.medianDurationSec) : undefined}
      pending={pending}
    />
  )
}

// Секунды в человеческий вид: 8 с, 2 мин 5 с, 1 ч 4 мин. Дробные секунды не
// показываем — точность медианы визитов их не заслуживает.
function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  if (total < 60) return `${total} с`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} мин ${total % 60} с`
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}
