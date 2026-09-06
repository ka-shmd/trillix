import { createFileRoute, Link } from '@tanstack/react-router'
import { usePlanLink } from '../../shared/planLink'
import { useQuery } from '@tanstack/react-query'

import {
  type LabelCount,
  type PlaceCount,
  type VisitsBreakdown,
} from '../../entities/visitsBreakdown'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { BreakdownTabs } from '../../features/insights/Breakdown'
import { VisitCards } from '../../features/insights/Cards'
import { visitsBreakdownQueryOptions } from '../../features/insights/queries'
import { ShareChart, VisitsChart } from '../../features/insights/lazyCharts'
import { pluralViews } from '../../shared/format'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'

// Вкладка «Визиты» (/forms/$slug/insights/visits): откуда пришли люди и с чего
// смотрели (спека design/analytics-tally.md §8).
//
// Всё считает сервер, сюда приезжают только счётчики. Шесть разбивок собраны в ДВА
// раздела с вкладками — «откуда приходят» и «с чего смотрят»: столбиком из шести
// списков вкладка заняла бы полтора экрана, хотя смотрят на один разрез за раз.
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
      <VisitCards slug={slug} period={period} />

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

      {/* Две колонки, а не шесть секций подряд. Внутри каждой — вкладки: разбивки
          одного раздела отвечают на один вопрос разными разрезами, и показывать их
          все сразу значит заставлять выбирать глазами. */}
      <div className="grid gap-8 md:grid-cols-2">
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
              { value: 'devices', label: 'Устройства', content: <Share rows={data.devices} /> },
              { value: 'browsers', label: 'Браузеры', content: <Share rows={data.browsers} /> },
              { value: 'systems', label: 'Система', content: <Share rows={data.systems} /> },
            ]}
          />
        </Section>
      </div>

      <p className="text-xs text-muted-foreground">
        Аналитика без cookie: мы не храним персональные данные посетителей.
      </p>
    </>
  )
}

// Все шесть разбивок вкладки показываются ОДИНАКОВО — кольцом с легендой. Вопрос
// к ним один и тот же: «как поделилось», и отвечает на него доля целого. Кольцо
// держит длинный хвост потому, что девятая строка и дальше сворачиваются в
// «Прочее», а числа хвоста показываются наведением (features/insights/ShareChart).
function Share({ rows }: { rows: LabelCount[] }) {
  if (rows.length === 0) return <NoRows />
  return <ShareChart rows={rows} />
}

function NoRows() {
  return <p className="text-sm text-muted-foreground">Данных нет.</p>
}

// Источники. Закрытая тарифом вкладка показывает НАСТОЯЩЕЕ число визитов с
// известным источником: плашка, рекламирующая пустоту, не продаёт ничего
// (docs/ANALYTICS.md §9).
function Sources({ data }: { data: VisitsBreakdown }) {
  const planLink = usePlanLink()
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
            <Link {...planLink}>Посмотреть тариф</Link>
          </Button>
        }
      />
    )
  }
  return (
    <Share
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
function Places({ rows, unknown }: { rows: PlaceCount[]; unknown?: number }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Место не определено ни у одного визита за период.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Share
        rows={rows.map((r) => ({
          label: `${flag(r.countryCode)} ${r.name}`.trim(),
          visits: r.visits,
        }))}
      />
      {/* Число без объяснения: сколько визитов не попало в список — это данные
          владельца, а ПОЧЕМУ они не попали (IPv6, приватные сети, пробелы
          справочника) — вопрос разработчика, и на экране ему не место. */}
      {unknown !== undefined && unknown > 0 && (
        <p className="text-xs text-muted-foreground">
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
