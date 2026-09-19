import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { type BlockSummary, type ScaleStats } from '../../entities/summary'
import { type BucketStep } from '../../entities/visitsBreakdown'
import { BarRows, type BarRow } from '../../features/insights/Breakdown'
import { AnswerFilterBar } from '../../features/insights/AnswerFilterBar'
import { SegmentPicker } from '../../features/insights/SegmentPicker'
import { VisitCards } from '../../features/insights/Cards'
import { CrosstabDialog } from '../../features/insights/CrosstabDialog'
import { ScaleTrendChart } from '../../features/insights/lazyCharts'
import { MIN_BASE, percentOf } from '../../features/insights/metrics'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { BlockAnswersDialog } from '../../features/submissions/BlockAnswersDialog'
import { submissionsSummaryQueryOptions } from '../../features/submissions/queries'
import { formatDate, LOCALE, pluralAnswers } from '../../shared/format'
import {
  decodeFilter,
  emptyScopeHint,
  encodeFilter,
  filterFromSearch,
  type FilterCondition,
} from '../../shared/answerFilter'
import { ApiError } from '../../shared/api/errors'
import { type Period } from '../../shared/period'
import { SEGMENT_K, segmentFromSearch } from '../../shared/segment'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'

// Вкладка «Сводка» (/forms/$slug/insights/answers): распределения, статистика чисел
// и доля заполнивших по каждому вопросу. Свой маршрут, а не локальный стейт табов
// (решение владельца): ссылка сохраняется в закладки, F5 её не сбрасывает, «Назад»
// браузера работает как ожидается. Шапка и разделы — на оболочке _manage, окно
// наблюдения и карточки — на оболочке раздела «Аналитика».
//
// Агрегат считает сервер — сюда приходят только счётчики (сырые ответы в браузер не
// выгружаются). Вопросы идут ОДНОЙ колонкой и без подложки: список вопросов читают
// сверху вниз, в том порядке, в каком их видел респондент, а вторая колонка ломает
// этот порядок пополам. Разделяет вопросы воздух, а не коробка.
//
// Фильтр (?where=, спека design/analytics-v2.md §6.2) — только этой вкладки: сводка и
// её окна «все ответы» считаются по ответам, прошедшим условия.
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/answers')({
  validateSearch: (search): { where?: string; segment?: string } => {
    const where = filterFromSearch(search.where)
    const segment = segmentFromSearch(search.segment)
    return { ...(where ? { where } : {}), ...(segment ? { segment } : {}) }
  },
  component: SummaryPage,
})

function SummaryPage() {
  // URL адресует форму slug'ом; UUID для запроса сводки берём из загруженной формы —
  // как на странице ответов.
  const { slug } = Route.useParams()
  const { period, where, segment } = Route.useSearch()
  const navigate = Route.useNavigate()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const summary = useQuery({
    ...submissionsSummaryQueryOptions(formId ?? '', period, where, segment),
    enabled: formId !== undefined,
  })
  // Вопросы для панели фильтра — из сводки без фильтра: при закрытом тарифе или пустой
  // выборке отфильтрованной сводки нет, а менять условия всё равно нужно. Запрос тот
  // же, что без фильтра, и берётся из кеша.
  const questions = useQuery({
    ...submissionsSummaryQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })
  const conditions = decodeFilter(where)
  const setConditions = (next: FilterCondition[]) =>
    void navigate({ search: (prev) => ({ ...prev, where: encodeFilter(next) }), replace: true })
  const setSegment = (next: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, segment: next }), replace: true })

  const total = summary.data?.total ?? 0
  const unfiltered = summary.data?.unfiltered
  const planRequired =
    summary.isError && summary.error instanceof ApiError && summary.error.code === 'plan_required'

  return (
    <div className="flex flex-col gap-12">
      {/* Полоса считает ту же совокупность, что разделы под ней: сегмент режет и её.
          Число ответов берётся из сводки — она его уже посчитала, и ручка счётчика
          сегмента всё равно не знает. Скрытая выборка (порог k) даёт прочерк. */}
      <VisitCards
        slug={slug}
        period={period}
        segment={segment}
        answers={
          segment === undefined
            ? undefined
            : {
                value: summary.data && !summary.data.withheld ? summary.data.total : undefined,
                pending: summary.isPending,
              }
        }
      />

      <Section
        title="Ответы по вопросам"
        description={
          summary.isSuccess && unfiltered !== undefined
            ? `Ответов в выборке: ${total} из ${unfiltered}`
            : summary.isSuccess && total > 0
              ? `${total} ${pluralAnswers(total)} за выбранный период`
              : 'Распределение ответов по каждому вопросу формы.'
        }
      >
        {formId && (
          <div className="flex flex-col gap-3">
            {/* Сегмент по визиту — тот же, что на «Отвалах»: ответы, пришедшие из этого
                источника, с этого устройства, из этой страны или по этой версии. */}
            <SegmentPicker formId={formId} period={period} segment={segment} onChange={setSegment} />
            {questions.data && questions.data.blocks.length > 0 && (
              <AnswerFilterBar
                blocks={questions.data.blocks}
                conditions={conditions}
                onChange={setConditions}
              />
            )}
          </div>
        )}
        {summary.isPending ? (
          <LoadingRows rows={3} />
        ) : planRequired ? (
          <EmptyState
            title="Фильтры и сегменты закрыты тарифом"
            description="Сводка по выбранной группе респондентов доступна на тарифе с аналитикой."
            action={
              <Button asChild size="sm">
                <Link to="/settings/plan">Посмотреть тариф</Link>
              </Button>
            }
          />
        ) : summary.isError ? (
          <ErrorState title="Не удалось посчитать сводку." onRetry={() => summary.refetch()} />
        ) : summary.data.withheld ? (
          <EmptyState
            title={`В выборке меньше ${SEGMENT_K} ответов`}
            description="По узкой группе распределения не показываются: так ответы нельзя связать с конкретным человеком. Расширьте период или выберите другой сегмент."
          />
        ) : total === 0 && unfiltered !== undefined ? (
          <EmptyState
            title="Под условия не подошёл ни один ответ"
            description={emptyScopeHint(where !== undefined, segment !== undefined)}
          />
        ) : total === 0 ? (
          <EmptyState
            title="Ответов пока нет"
            description="Опубликуйте форму и поделитесь ссылкой — сводка появится здесь. Если ответы были раньше, расширьте период."
          />
        ) : summary.data.blocks.length === 0 ? (
          // Ответы есть, а вопросов нет: все вопросы формы удалены после сбора
          // ответов. Не пустой экран, а объяснение — иначе выглядит как поломка.
          <EmptyState
            title="Сводить нечего"
            description="В опубликованных версиях формы нет вопросов. Сами ответы доступны в таблице."
          />
        ) : (
          <div className="flex flex-col gap-8">
            {summary.data.blocks.map((b) => (
              <BlockCard
                key={b.blockId}
                block={b}
                total={total}
                trendStep={summary.data.trendStep}
                formId={formId ?? ''}
                period={period}
                where={where}
                segment={segment}
                closed={summary.data.blocks.filter((o) => o.kind === 'distribution')}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function BlockCard({
  block,
  total,
  trendStep,
  formId,
  period,
  where,
  segment,
  closed,
}: {
  block: BlockSummary
  total: number
  trendStep: BucketStep
  formId: string
  period: Period
  where: string | undefined
  segment: string | undefined
  // Закрытые вопросы сводки — с ними этот можно сравнить таблицей.
  closed: BlockSummary[]
}) {
  const [allOpen, setAllOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const others = block.kind === 'distribution' ? closed.filter((o) => o.blockId !== block.blockId) : []

  return (
    <article className="flex flex-col gap-3">
      <div>
        <h3 className="font-semibold">{block.label}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Ответили {block.answered} из {block.asked}
          {/* Знаменатель меньше числа ответов формы — значит вопрос видели не все: он за
              условием, на пропущенной странице или появился в поздней версии (фаза 21).
              Без этой оговорки владелец сравнивает «12 из 34» с «400 ответов» на карточке
              формы и читает расхождение как поломку. */}
          {block.asked < total && ` — вопрос показали ${block.asked} из ${total}`}
        </p>
      </div>
      {block.scale && <ScaleSummary block={block} scale={block.scale} step={trendStep} />}
      {block.kind === 'distribution' ? (
        <Distribution block={block} />
      ) : block.kind === 'number' ? (
        <NumberStats block={block} />
      ) : (
        <Samples block={block} />
      )}
      {others.length > 0 && block.answered > 0 && (
        <>
          <Button
            variant="link"
            size="sm"
            className="h-auto justify-start p-0"
            onClick={() => setCompareOpen(true)}
          >
            Сравнить с другим вопросом
          </Button>
          <CrosstabDialog
            open={compareOpen}
            onOpenChange={setCompareOpen}
            formId={formId}
            period={period}
            where={where}
            segment={segment}
            block={block}
            others={others}
          />
        </>
      )}
      {/* «Все ответы» показывается, только когда показано не всё: сводка отдаёт
          десять последних значений, и у вопроса с девятью ответами кнопка открыла
          бы окно с тем же самым списком. */}
      {block.samples.length > 0 && block.answered > block.samples.length && (
        <>
          <Button
            variant="link"
            size="sm"
            className="h-auto justify-start p-0"
            onClick={() => setAllOpen(true)}
          >
            Все ответы
          </Button>
          <BlockAnswersDialog
            open={allOpen}
            onOpenChange={setAllOpen}
            formId={formId}
            blockId={block.blockId}
            label={block.label}
            answered={block.answered}
            period={period}
            where={where}
            segment={segment}
          />
        </>
      )}
    </article>
  )
}

function Distribution({ block }: { block: BlockSummary }) {
  if (block.buckets.length === 0) {
    return <p className="text-sm text-muted-foreground">В этом вопросе нет вариантов.</p>
  }
  // База процента — ответившие («52 % ответивших выбрали Рекламу»). У множественного
  // выбора сумма долей поэтому больше 100 % — так и надо: человек выбирает несколько
  // вариантов, и доля считается от людей, а не от галочек.
  const base = block.answered
  const rows: BarRow[] = block.buckets.map((b) => ({
    key: b.key,
    label: b.label,
    count: b.count,
    // Ширина полоски и названный процент — от ОДНОЙ базы: у распределения доля
    // осмысленна сама по себе («52 % выбрали Рекламу»), в отличие от списков
    // визитов, где полоска меряется максимумом строки.
    share: base > 0 ? b.count / base : 0,
    percent: percentOf(b.count, base),
  }))
  return <BarRows rows={rows} />
}

// Последние ответы под вопросом — вместо доли заполнивших у текстовых типов.
// Именно ради них раскладка и переехала: полоска «заполнили 12 из 34» у открытого
// вопроса не говорит ничего, а сами ответы — говорят всё.
//
// Значений не больше десяти (потолок ставит сервер), дальше — ссылка в таблицу
// ответов со своей пагинацией.
function Samples({ block }: { block: BlockSummary }) {
  if (block.samples.length === 0) {
    return (
      <BarRows
        rows={[
          {
            key: 'filled',
            label: 'Заполнили',
            count: block.answered,
            share: block.asked > 0 ? block.answered / block.asked : 0,
            percent: percentOf(block.answered, block.asked),
          },
        ]}
      />
    )
  }
  return (
    <ul className="flex flex-col">
      {block.samples.map((s, i) => (
        <li
          key={`${s.at}-${i}`}
          className="flex justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-0"
        >
          <span className="min-w-0 break-words">{s.text}</span>
          <span className="shrink-0 text-muted-foreground">{formatDate(s.at)}</span>
        </li>
      ))}
    </ul>
  )
}

const numberFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })

function NumberStats({ block }: { block: BlockSummary }) {
  if (!block.number) {
    return <p className="text-sm text-muted-foreground">На этот вопрос никто не ответил.</p>
  }
  const { avg, min, max } = block.number
  return (
    <dl className="grid grid-cols-3 gap-4">
      {[
        ['Среднее', avg],
        ['Минимум', min],
        ['Максимум', max],
      ].map(([title, value]) => (
        <div key={title as string}>
          <dt className="text-sm text-muted-foreground">{title}</dt>
          <dd className="mt-0.5 text-xl font-bold tabular-nums">
            {numberFmt.format(value as number)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const signedFmt = new Intl.NumberFormat(LOCALE, { signDisplay: 'exceptZero' })

// Шкала и звёзды: средняя, NPS у шкалы 0–10 и ряд средней. NPS — разность долей,
// поэтому подчиняется порогу малых выборок: «−100» по одному ответу владелец прочтёт
// как приговор форме. Ряд рисуется, когда непустых корзин хотя бы две — одна точка
// не линия.
function ScaleSummary({
  block,
  scale,
  step,
}: {
  block: BlockSummary
  scale: ScaleStats
  step: BucketStep
}) {
  const marks = block.buckets.map((b) => Number(b.key)).filter((n) => Number.isFinite(n))
  const min = marks.length > 0 ? Math.min(...marks) : 0
  const max = marks.length > 0 ? Math.max(...marks) : 5
  const filled = scale.trend.filter((p) => p.n > 0).length
  const showNps = scale.nps !== undefined && block.answered >= MIN_BASE

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-muted-foreground">Средняя</dt>
          <dd className="mt-0.5 text-xl font-bold tabular-nums">
            {numberFmt.format(scale.avg)}
            <span className="text-sm font-normal text-muted-foreground"> из {max}</span>
          </dd>
        </div>
        {showNps && (
          <div>
            <dt className="text-sm text-muted-foreground">NPS</dt>
            <dd className="mt-0.5 text-xl font-bold tabular-nums">{signedFmt.format(scale.nps!)}</dd>
          </div>
        )}
      </dl>
      {filled >= 2 && <ScaleTrendChart points={scale.trend} step={step} min={min} max={max} />}
    </div>
  )
}
