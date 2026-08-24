import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import {
  type LabelCount,
  type TimeBucket,
  type VisitsBreakdown,
} from '../../entities/visitsBreakdown'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { visitsBreakdownQueryOptions } from '../../features/insights/queries'
import { pluralViews } from '../../shared/format'
import { Button } from '@/components/ui/button'

// Вкладка «Визиты» (/forms/$slug/insights/visits): откуда пришли люди и с чего
// смотрели (спека design/analytics-tally.md §8).
//
// Всё считает сервер, сюда приезжают только счётчики. График — на CSS-полосках, как
// бары сводки и воронки: графических библиотек в проекте нет, список зависимостей
// заморожен (web/CLAUDE.md).
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/visits')({
  component: VisitsPage,
})

function VisitsPage() {
  const { slug } = Route.useParams()
  const { period } = Route.useSearch()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const breakdown = useQuery({
    ...visitsBreakdownQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })

  if (breakdown.isPending) {
    return <p className="text-sm text-muted-foreground">Считаем визиты…</p>
  }
  if (breakdown.isError) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
        <p className="mb-3 text-sm">Не удалось загрузить визиты.</p>
        <Button variant="outline" size="sm" onClick={() => breakdown.refetch()}>
          Повторить
        </Button>
      </div>
    )
  }

  const data = breakdown.data
  // Пустой ряд — это «визитов за период не было», и рисовать вместо него график из
  // нулей нельзя: пустое состояние и нулевые данные читаются по-разному.
  if (data.timeseries.length === 0) {
    return (
      <div className="mx-auto mt-12 max-w-md text-center">
        <h2 className="text-lg font-medium">Визитов за период нет</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Поделитесь ссылкой на форму — или расширьте период, если визиты были раньше.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <Timeseries buckets={data.timeseries} step={data.step} />
      <div className="grid gap-8 sm:grid-cols-2">
        <Sources data={data} />
        <Breakdown title="Устройства" rows={data.devices} />
        <Breakdown title="Браузеры" rows={data.browsers} />
        <Breakdown title="Операционные системы" rows={data.systems} />
      </div>
      <p className="text-xs text-muted-foreground">
        Аналитика без cookie и кросс-девайс-трекинга: визит не переживает закрытие
        вкладки, IP не сохраняется.
      </p>
    </div>
  )
}

const hourFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

// Ряд по времени: две полоски на корзину — визиты и из них отправившие. Высота
// считается от максимума ряда, поэтому график остаётся читаемым и на трёх визитах,
// и на трёх тысячах.
function Timeseries({ buckets, step }: { buckets: TimeBucket[]; step: 'hour' | 'day' }) {
  const max = Math.max(...buckets.map((b) => b.visits), 1)
  const total = buckets.reduce((sum, b) => sum + b.visits, 0)
  const submitted = buckets.reduce((sum, b) => sum + b.submitted, 0)
  const fmt = step === 'hour' ? hourFmt : dayFmt
  // Границы ряда достаём переменными, а не индексами в разметке: пустой ряд сюда не
  // доходит (его перехватывает пустое состояние выше), но тип этого не знает, и
  // проверка честнее, чем восклицательный знак.
  const first = buckets.at(0)
  const last = buckets.at(-1)

  return (
    <section>
      <h2 className="mb-1 font-medium">
        {total} {pluralViews(total)}
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">из них {submitted} с ответом</p>
      <div className="flex h-40 items-end gap-1">
        {buckets.map((b) => (
          <div key={b.at} className="flex h-full flex-1 flex-col justify-end gap-0.5">
            {/* Заголовок нативный: то же число уже прочитано в шапке секции, а
                тултип поверх столбика потребовал бы либо новой зависимости, либо
                своего поповера ради подписи из двух чисел. */}
            <div
              className="w-full rounded-sm bg-primary/25"
              style={{ height: `${(b.visits / max) * 100}%` }}
              title={`${fmt.format(new Date(b.at))}: ${b.visits} ${pluralViews(b.visits)}, ${b.submitted} с ответом`}
            />
            <div
              className="w-full rounded-sm bg-primary"
              style={{ height: `${(b.submitted / max) * 100}%` }}
              aria-hidden="true"
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{first && fmt.format(new Date(first.at))}</span>
        <span>{last && fmt.format(new Date(last.at))}</span>
      </div>
    </section>
  )
}

// Источники. Закрытая тарифом секция показывает НАСТОЯЩЕЕ число визитов с
// известным источником: плашка, рекламирующая пустоту, не продаёт ничего
// (docs/ANALYTICS.md §9).
function Sources({ data }: { data: VisitsBreakdown }) {
  if (data.sourcesLocked) {
    return (
      <section>
        <h2 className="mb-3 font-medium">Источники</h2>
        <div className="rounded-lg border border-dashed p-5 text-center">
          <p className="text-sm">
            {data.knownSources > 0
              ? `${data.knownSources} ${pluralViews(data.knownSources)} пришли по размеченным ссылкам и с других сайтов.`
              : 'Пока все визиты — прямые заходы.'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Разбивка по источникам доступна на платном тарифе.
          </p>
        </div>
      </section>
    )
  }
  return (
    <Breakdown
      title="Источники"
      rows={data.sources.map((s) => ({
        label: s.medium === 'Нет' ? s.source : `${s.source} / ${s.medium}`,
        visits: s.visits,
      }))}
    />
  )
}

// Список с полоской: подпись, число, доля от максимума строки. Доля именно от
// максимума, а не от суммы: у списка своя задача — сравнить строки между собой.
function Breakdown({ title, rows }: { title: string; rows: LabelCount[] }) {
  const max = Math.max(...rows.map((r) => r.visits), 1)
  return (
    <section>
      <h2 className="mb-3 font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Данных нет.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.label} className="relative overflow-hidden rounded-md bg-muted/50">
              <div
                className="absolute inset-y-0 left-0 bg-muted"
                style={{ width: `${(r.visits / max) * 100}%` }}
                aria-hidden="true"
              />
              <div className="relative flex justify-between gap-4 px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate">{r.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{r.visits}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
