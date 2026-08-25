import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import {
  type LabelCount,
  type PlaceCount,
  type TimeBucket,
  type VisitsBreakdown,
} from '../../entities/visitsBreakdown'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { VisitCards } from '../../features/insights/Cards'
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

  const cards = <VisitCards slug={slug} period={period} />

  if (breakdown.isPending) {
    return (
      <>
        {cards}
        <p className="text-sm text-muted-foreground">Считаем визиты…</p>
      </>
    )
  }
  if (breakdown.isError) {
    return (
      <>
        {cards}
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Не удалось загрузить визиты.</p>
          <Button variant="outline" size="sm" onClick={() => breakdown.refetch()}>
            Повторить
          </Button>
        </div>
      </>
    )
  }

  const data = breakdown.data
  // Пустой ряд — это «визитов за период не было», и рисовать вместо него график из
  // нулей нельзя: пустое состояние и нулевые данные читаются по-разному.
  if (data.timeseries.length === 0) {
    return (
      <>
        {cards}
        <div className="mx-auto mt-12 max-w-md text-center">
          <h2 className="text-lg font-medium">Визитов за период нет</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Поделитесь ссылкой на форму — или расширьте период, если визиты были раньше.
          </p>
        </div>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      {cards}
      <Timeseries buckets={data.timeseries} step={data.step} />
      <div className="grid gap-8 sm:grid-cols-2">
        <Sources data={data} />
        <Breakdown title="Устройства" rows={data.devices} />
        {/* Три состояния, и их нельзя схлопывать в два. ЕСТЬ данные — рисуем
            всегда, даже если справочник сейчас отключён: собранные страны никуда
            не делись и остаются правдой. НЕТ данных, но справочник подключён —
            рисуем с объяснением. НЕТ данных и справочника нет — блок исчезает
            целиком, потому что рассказывать не о чем. Без среднего случая
            выключенное гео неотличимо от ненаписанной функции — ровно так оно и
            выглядело владельцу. */}
        {(data.countries.length > 0 || data.geoConfigured) && (
          <Places title="Страны" rows={data.countries} unknown={data.unknownPlace} />
        )}
        {(data.cities.length > 0 || data.geoConfigured) && (
          <Places title="Города" rows={data.cities} />
        )}
        <Breakdown title="Браузеры" rows={data.browsers} />
        <Breakdown title="Операционные системы" rows={data.systems} />
      </div>
      <p className="text-xs text-muted-foreground">
        Аналитика без cookie: мы не храним персональные данные посетителей.
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

// Страны и города. Флаг — эмодзи из кода страны: два региональных индикатора, то
// есть две буквы кода, сдвинутые в свой блок Unicode. Ни картинок, ни спрайта, ни
// зависимости — и в списке видно страну, не читая названия.
function Places({ title, rows, unknown }: { title: string; rows: PlaceCount[]; unknown?: number }) {
  if (rows.length === 0) {
    return (
      <section>
        <h2 className="mb-3 font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">
          Место не определено ни у одного визита за период.
        </p>
      </section>
    )
  }
  return (
    <div>
      <Breakdown
        title={title}
        rows={rows.map((r) => ({ label: `${flag(r.countryCode)} ${r.name}`.trim(), visits: r.visits }))}
      />
      {/* Число без объяснения: сколько визитов не попало в список — это данные
          владельца, а ПОЧЕМУ они не попали (IPv6, приватные сети, пробелы
          справочника) — вопрос разработчика, и на экране ему не место. */}
      {unknown !== undefined && unknown > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Ещё {unknown} {pluralViews(unknown)} без страны
        </p>
      )}
    </div>
  )
}

// flag превращает ISO-код страны в эмодзи флага. Пустой или неполный код даёт
// пустую строку — рисовать вопросительный знак вместо флага незачем.
function flag(code: string): string {
  if (code.length !== 2) return ''
  const base = 0x1f1e6 // региональный индикатор «A»
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => base + (c.charCodeAt(0) - 65)),
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
