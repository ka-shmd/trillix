import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type PlaceCount, type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { BreakdownList, BreakdownTabs, type BreakdownRow } from '../../features/insights/Breakdown'
import { InsightCards } from '../../features/insights/Cards'
import { visitsBreakdownQueryOptions } from '../../features/insights/queries'
import { VisitsChart } from '../../features/insights/lazyCharts'
import { pluralViews } from '../../shared/format'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'

// Вкладка «Визиты» (/forms/$slug/insights/visits): кто приходит — откуда, с чего и
// когда (спека design/analytics-v3.md §5).
//
// Всё считает сервер, сюда приезжают только счётчики. Разделов два, и оба идут В
// ОДНУ КОЛОНКУ во всю ширину: пока они стояли парой колонок, на разбивку оставалось
// пол-экрана, и подписи источников и городов в них не помещались.
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

  return (
    <div className="flex flex-col gap-12">
      <InsightCards slug={slug} period={period} />

      {breakdown.isPending ? (
        <LoadingRows rows={2} />
      ) : breakdown.isError ? (
        <ErrorState title="Не удалось загрузить визиты." onRetry={() => breakdown.refetch()} />
      ) : breakdown.data.timeseries.length === 0 ? (
        // Пустой ряд — это «визитов за период не было», и рисовать вместо него
        // график из нулей нельзя: пустое состояние и нулевые данные читаются
        // по-разному.
        <EmptyState
          title="Визитов за период нет"
          description="Поделитесь ссылкой на форму — или расширьте период, если визиты были раньше."
        />
      ) : (
        <Breakdowns data={breakdown.data} />
      )}
    </div>
  )
}

function Breakdowns({ data }: { data: VisitsBreakdown }) {
  const total = data.timeseries.reduce((sum, b) => sum + b.visits, 0)
  const submitted = data.timeseries.reduce((sum, b) => sum + b.submitted, 0)

  return (
    <>
      <Section
        title="Визиты по времени"
        description={`${total} ${pluralViews(total)} за период, из них ${submitted} с ответом.`}
      >
        <VisitsChart buckets={data.timeseries} step={data.step} />
      </Section>

      {/* Внутри раздела — вкладки: разбивки одного раздела отвечают на один вопрос
          разными разрезами, и показывать их все сразу значит заставлять выбирать
          глазами. Разделов при этом два, а не шесть: столбиком из шести списков
          вкладка заняла бы полтора экрана. */}
      <Section
        title="Откуда приходят"
        description="По каким ссылкам и из каких мест открывают форму."
      >
        <BreakdownTabs
          panels={[
            { value: 'sources', label: 'Источники', content: <Sources data={data} /> },
            // Три состояния, и их нельзя схлопывать в два. ЕСТЬ данные — рисуем
            // всегда, даже если справочник сейчас отключён: собранные страны
            // никуда не делись и остаются правдой. НЕТ данных, но справочник
            // подключён — рисуем с объяснением. НЕТ данных и справочника нет —
            // вкладка исчезает целиком, потому что рассказывать не о чем. Без
            // среднего случая выключенное гео неотличимо от ненаписанной функции
            // — ровно так оно и выглядело владельцу.
            ...(data.countries.length > 0 || data.geoConfigured
              ? [
                  {
                    value: 'countries',
                    label: 'Страны',
                    content: <Places rows={data.countries} unknown={data.unknownPlace} />,
                  },
                ]
              : []),
            ...(data.cities.length > 0 || data.geoConfigured
              ? [{ value: 'cities', label: 'Города', content: <Places rows={data.cities} /> }]
              : []),
          ]}
        />
      </Section>

      <Section title="С чего смотрят" description="Устройство, браузер и система посетителей.">
        <BreakdownTabs
          panels={[
            { value: 'devices', label: 'Устройства', content: <Labels rows={data.devices} /> },
            { value: 'browsers', label: 'Браузеры', content: <Labels rows={data.browsers} /> },
            { value: 'systems', label: 'Система', content: <Labels rows={data.systems} /> },
          ]}
        />
      </Section>

      <p className="text-sm text-muted-foreground">
        Аналитика без cookie: мы не храним персональные данные посетителей.
      </p>
    </>
  )
}

function Labels({ rows }: { rows: { label: string; visits: number; submitted: number }[] }) {
  return <BreakdownList rows={rows.map((r) => ({ ...r, key: r.label }))} />
}

// Источники. Закрытая тарифом вкладка показывает НАСТОЯЩЕЕ число визитов с
// известным источником: плашка, рекламирующая пустоту, не продаёт ничего
// (docs/ANALYTICS.md §9).
function Sources({ data }: { data: VisitsBreakdown }) {
  if (data.sourcesLocked) {
    return (
      <EmptyState
        title={
          data.knownSources > 0
            ? `${data.knownSources} ${pluralViews(data.knownSources)} пришли по размеченным ссылкам и с других сайтов`
            : 'Пока все визиты — прямые заходы'
        }
        description="Разбивка по источникам доступна на платном тарифе."
        action={
          <Button asChild size="sm">
            <Link to="/settings/plan">Посмотреть тариф</Link>
          </Button>
        }
      />
    )
  }
  return (
    <BreakdownList
      rows={data.sources.map((s) => ({
        key: `${s.source}/${s.medium}`,
        label: s.medium === 'Нет' ? s.source : `${s.source} / ${s.medium}`,
        visits: s.visits,
        submitted: s.submitted,
      }))}
    />
  )
}

// Страны и города. Флаг — эмодзи из кода страны: два региональных индикатора, то
// есть две буквы кода, сдвинутые в свой блок Unicode. Ни картинок, ни спрайта, ни
// зависимости — и в списке видно страну, не читая названия.
function Places({ rows, unknown }: { rows: PlaceCount[]; unknown?: number }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Место не определено ни у одного визита за период.
      </p>
    )
  }
  const list: BreakdownRow[] = rows.map((r) => ({
    key: `${r.countryCode}/${r.name}`,
    label: `${flag(r.countryCode)} ${r.name}`.trim(),
    visits: r.visits,
    submitted: r.submitted,
  }))
  return (
    <div className="flex flex-col gap-2">
      <BreakdownList rows={list} />
      {/* Число без объяснения: сколько визитов не попало в список — это данные
          владельца, а ПОЧЕМУ они не попали (IPv6, приватные сети, пробелы
          справочника) — вопрос разработчика, и на экране ему не место. */}
      {unknown !== undefined && unknown > 0 && (
        <p className="text-sm text-muted-foreground">
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
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => base + (c.charCodeAt(0) - 65)))
}
