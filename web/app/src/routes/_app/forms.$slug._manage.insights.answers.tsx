import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { type BlockSummary, type ScaleStats } from '../../entities/summary'
import { BarRows, type BarRow } from '../../features/insights/Breakdown'
import { InsightCards } from '../../features/insights/Cards'
import { CrosstabDialog } from '../../features/insights/CrosstabDialog'
import { ScopeBar } from '../../features/insights/ScopeBar'
import { ScaleTrendChart } from '../../features/insights/lazyCharts'
import { MIN_BASE, percentText } from '../../features/insights/metrics'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { BlockAnswersDialog } from '../../features/submissions/BlockAnswersDialog'
import { submissionsSummaryQueryOptions } from '../../features/submissions/queries'
import { BlockTypeIcon } from '../../shared/BlockTypeIcon'
import { formatDate, LOCALE, pluralAnswers } from '../../shared/format'
import {
  decodeFilter,
  emptyScopeHint,
  encodeFilter,
  equalsOp,
  filterFromSearch,
  withCondition,
  type FilterCondition,
} from '../../shared/answerFilter'
import { ApiError } from '../../shared/api/errors'
import { type Period } from '../../shared/period'
import { SEGMENT_K, segmentsFromSearch, segmentsToSearch } from '../../shared/segment'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Вкладка «Ответы» (/forms/$slug/insights/answers): что отвечают.
//
// СВЁРНУТЫЙ СПИСОК (решение владельца 2026-09-19: «слишком много информации,
// непонятный вид, много неудобных контролов»). Строка на вопрос: глиф типа,
// текст вопроса, ГЛАВНЫЙ ОТВЕТ одним числом. Распределение раскрывается щелчком.
//
// Было иначе: все вопросы разом, с полными распределениями и двумя синими ссылками
// под каждым. Форма из четырнадцати вопросов занимала шесть экранов прокрутки, из
// которых первые два — списки имён и почтовых адресов. Свёрнутый список решает обе
// беды сразу: вся форма видна целиком, а персональные данные не лежат на обзорном
// экране — они внутри своего вопроса, куда надо зайти намеренно.
//
// Раскрытое живёт в СОСТОЯНИИ, а не в адресе: это не место в кабинете, а поза
// чтения. Ссылка «посмотри на это» ведёт на вопрос, а не на «вопрос, раскрытый у
// меня в браузере».
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/answers')({
  validateSearch: (search): { where?: string; segment?: string | string[] } => {
    const where = filterFromSearch(search.where)
    const segment = segmentsToSearch(segmentsFromSearch(search.segment))
    return { ...(where ? { where } : {}), ...(segment ? { segment } : {}) }
  },
  component: AnswersPage,
})

function AnswersPage() {
  // URL адресует форму slug'ом; UUID для запроса сводки берём из загруженной формы —
  // как на странице ответов.
  const { slug } = Route.useParams()
  const { period, where, segment } = Route.useSearch()
  const segments = segmentsFromSearch(segment)
  const navigate = Route.useNavigate()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const summary = useQuery({
    ...submissionsSummaryQueryOptions(formId ?? '', period, where, segments),
    enabled: formId !== undefined,
  })
  // Вопросы для панели выборки — из сводки без неё: при закрытом тарифе или пустом
  // результате отфильтрованной сводки нет, а менять условия всё равно нужно. Запрос
  // тот же, что без выборки, и берётся из кеша.
  const questions = useQuery({
    ...submissionsSummaryQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })
  const setWhere = (next: FilterCondition[]) =>
    void navigate({ search: (prev) => ({ ...prev, where: encodeFilter(next) }), replace: true })
  const setSegments = (next: string[]) =>
    void navigate({
      search: (prev) => ({ ...prev, segment: segmentsToSearch(next) }),
      replace: true,
    })

  // ЩЕЛЧОК ПО ВАРИАНТУ — тот же фильтр, что в окне выборки (решение владельца
  // 2026-09-20). Собирать условие «Город равен Москва» из списков, стоя перед
  // строкой «Москва», — работа, которую человек уже сделал глазами. Правило
  // сложения условий общее с окном (shared/answerFilter.ts).
  const conditions = decodeFilter(where)

  const total = summary.data?.total ?? 0
  const unfiltered = summary.data?.unfiltered
  const planRequired =
    summary.isError && summary.error instanceof ApiError && summary.error.code === 'plan_required'

  return (
    <div className="flex flex-col gap-12">
      {/* Выборка стоит НАД полосой карточек, а не в шапке раздела под ней: она
          режет и карточки тоже, а контрол под своим результатом читается как
          относящийся к одному списку вопросов. */}
      <div className="flex flex-col gap-4">
        {formId && (
          <ScopeBar
            formId={formId}
            period={period}
            segments={segments}
            where={where}
            blocks={questions.data?.blocks ?? []}
            onSegments={setSegments}
            onWhere={setWhere}
          />
        )}
        {/* Полоса считает ту же совокупность, что список под ней: выборка режет и
            её. Числа ответов на полосе нет — оно в пояснении раздела: полоса
            говорит о визитах, и submissions рядом с «Отправили» читались бы как
            расхождение (спека design/analytics-v3.md §3). */}
        <InsightCards slug={slug} period={period} segments={segments} />
      </div>

      <Section
        title="Ответы по вопросам"
        description={
          summary.isSuccess && unfiltered !== undefined
            ? `${total} из ${unfiltered} ${pluralAnswers(unfiltered)} подходят под выборку`
            : summary.isSuccess && total > 0
              ? `${total} ${pluralAnswers(total)} за выбранный период`
              : undefined
        }
      >
        {summary.isPending ? (
          <LoadingRows rows={3} />
        ) : planRequired ? (
          <EmptyState
            title="Выборка закрыта тарифом"
            description="Сводка по выбранной группе респондентов доступна на тарифе с аналитикой."
            action={
              <Button asChild size="sm">
                <Link to="/settings/plan">Посмотреть тариф</Link>
              </Button>
            }
          />
        ) : summary.isError ? (
          <ErrorState title="Не удалось посчитать сводку." onRetry={() => summary.refetch()} />
        ) : summary.data.noVisitLink ? (
          // Важнее порога малых выборок: при нулевой связке «ответ — визит» и
          // withheld, и «ноль подошло» правдивы формально, но оба зовут менять
          // период, а период тут ни при чём.
          <EmptyState
            title="У этих ответов нет меток визита"
            description="Мы связываем ответ с визитом, из которого он пришёл, — но только у ответов, собранных после появления этой связи. Ответы за выбранный период пришли раньше, поэтому разрез по устройству, источнику и месту для них не считается. Выберите период поновее или разрез по версии формы."
          />
        ) : summary.data.withheld ? (
          <EmptyState
            title={`В выборке меньше ${SEGMENT_K} ответов`}
            description="По узкой группе распределения не показываются: так ответы нельзя связать с конкретным человеком. Расширьте период или выберите другой сегмент."
          />
        ) : total === 0 && unfiltered !== undefined ? (
          <EmptyState
            title="Под условия не подошёл ни один ответ"
            description={emptyScopeHint(where !== undefined, segments.length > 0)}
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
          <ul className="flex flex-col">
            {summary.data.blocks.map((b) => (
              <QuestionRow
                key={b.blockId}
                block={b}
                total={total}
                formId={formId ?? ''}
                period={period}
                where={where}
                segments={segments}
                closed={summary.data.blocks.filter((o) => o.kind === 'distribution')}
                conditions={conditions}
                onToggleCondition={(c) => setWhere(withCondition(conditions, c))}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

const numberFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })
const signedFmt = new Intl.NumberFormat(LOCALE, { signDisplay: 'exceptZero' })

// Главный ответ вопроса — то, ради чего строку читают, не раскрывая. У закрытого
// вопроса это самый частый вариант, у шкалы — средняя и NPS, у числового — медиана
// (средняя живёт под выбросами), у остального — сколько заполнили.
function headline(block: BlockSummary): string {
  if (block.answered === 0) return 'нет ответов'
  if (block.scale) {
    const avg = numberFmt.format(block.scale.avg)
    const nps =
      block.scale.nps !== undefined && block.answered >= MIN_BASE
        ? ` · NPS ${signedFmt.format(block.scale.nps)}`
        : ''
    return `${avg}${nps}`
  }
  if (block.kind === 'number' && block.number) {
    return `медиана ${numberFmt.format(block.number.median)}`
  }
  if (block.kind === 'distribution') {
    const top = block.buckets.reduce(
      (best, b) => (best === null || b.count > best.count ? b : best),
      null as (typeof block.buckets)[number] | null,
    )
    if (!top || top.count === 0) return `${block.answered} ${pluralAnswers(block.answered)}`
    return `${top.label} — ${percentText(top.count, block.answered)}`
  }
  return `${block.answered} ${pluralAnswers(block.answered)}`
}

function QuestionRow({
  block,
  total,
  formId,
  period,
  where,
  segments,
  closed,
  conditions,
  onToggleCondition,
}: {
  block: BlockSummary
  total: number
  formId: string
  period: Period
  where: string | undefined
  segments: string[]
  // Закрытые вопросы сводки — с ними этот можно сравнить таблицей.
  closed: BlockSummary[]
  conditions: FilterCondition[]
  onToggleCondition: (c: FilterCondition) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <li className="border-b border-border/60 last:border-0">
      {/* Вся строка — кнопка: цель щелчка в ширину страницы, а не в значок 16 px.
          aria-expanded обязателен, иначе скринридер не скажет, что строка
          раскрывается. */}
      <button
        type="button"
        className="flex w-full items-center gap-3 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BlockTypeIcon type={block.type} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-base font-semibold">{block.label}</span>
        <span className="shrink-0 text-sm tabular-nums">{headline(block)}</span>
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
      </button>
      {open && (
        <QuestionBody
          block={block}
          total={total}
          formId={formId}
          period={period}
          where={where}
          segments={segments}
          closed={closed}
          conditions={conditions}
          onToggleCondition={onToggleCondition}
        />
      )}
    </li>
  )
}

function QuestionBody({
  block,
  total,
  formId,
  period,
  where,
  segments,
  closed,
  conditions,
  onToggleCondition,
}: {
  block: BlockSummary
  total: number
  formId: string
  period: Period
  where: string | undefined
  segments: string[]
  closed: BlockSummary[]
  conditions: FilterCondition[]
  onToggleCondition: (c: FilterCondition) => void
}) {
  const [allOpen, setAllOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const others = block.kind === 'distribution' ? closed.filter((o) => o.blockId !== block.blockId) : []

  return (
    <div className="flex flex-col gap-4 pb-5 pl-7">
      {/* Знаменатель печатается, ТОЛЬКО когда он о чём-то говорит. У формы, где на
          вопрос ответили все, «Ответили 2037 из 2037» повторялось под каждым из
          четырнадцати вопросов и не сообщало ничего.

          Знаменатель меньше числа ответов формы — значит вопрос видели не все: он за
          условием, на пропущенной странице или появился в поздней версии (фаза 21).
          Без этой оговорки владелец сравнивает «12 из 34» с «400 ответов» на карточке
          формы и читает расхождение как поломку. */}
      {(block.answered < block.asked || block.asked < total) && (
        <p className="text-sm text-muted-foreground">
          Ответили {block.answered} из {block.asked}
          {block.asked < total && ` — вопрос показали ${block.asked} из ${total}`}
        </p>
      )}

      {block.scale && <ScaleSummary block={block} scale={block.scale} />}
      {block.kind === 'distribution' ? (
        <Distribution block={block} conditions={conditions} onToggle={onToggleCondition} />
      ) : block.kind === 'number' ? (
        <NumberStats block={block} />
      ) : (
        <Samples block={block} />
      )}

      {/* Действия вопроса — здесь, а не под каждой строкой списка: раскрытых
          вопросов на экране один-два, а строк четырнадцать (решение владельца
          2026-09-19, «убрать с глаз»). */}
      {(others.length > 0 || block.samples.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {others.length > 0 && block.answered > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={() => setCompareOpen(true)}>
                Сравнить с другим вопросом
              </Button>
              <CrosstabDialog
                open={compareOpen}
                onOpenChange={setCompareOpen}
                formId={formId}
                period={period}
                where={where}
                segments={segments}
                block={block}
                others={others}
              />
            </>
          )}
          {/* «Все ответы» показывается, только когда показано не всё: сводка отдаёт
              десять последних значений, и у вопроса с девятью ответами кнопка
              открыла бы окно с тем же самым списком. */}
          {block.samples.length > 0 && block.answered > block.samples.length && (
            <>
              <Button variant="outline" size="sm" onClick={() => setAllOpen(true)}>
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
                segments={segments}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Distribution({
  block,
  conditions,
  onToggle,
}: {
  block: BlockSummary
  conditions: FilterCondition[]
  onToggle: (c: FilterCondition) => void
}) {
  if (block.buckets.length === 0) {
    return <p className="text-sm text-muted-foreground">В этом вопросе нет вариантов.</p>
  }
  // База процента — ответившие («52 % ответивших выбрали Рекламу»). У множественного
  // выбора сумма долей поэтому больше 100 % — так и надо: человек выбирает несколько
  // вариантов, и доля считается от людей, а не от галочек.
  const base = block.answered
  // Варианты — ПО УБЫВАНИЮ, деления шкалы — по порядку шкалы. У выбора порядок
  // вариантов вопроса не значит ничего, и полоски шли пилой (355, 709, 554…),
  // из-за чего ранг приходилось искать глазами. У шкалы порядок несущий: «1, 2,
  // 3…» это и есть форма распределения, и сортировка по убыванию её уничтожает.
  const ordered = block.scale ? block.buckets : [...block.buckets].sort((a, b) => b.count - a.count)
  // Щелчок по строке оставляет только эти ответы. Оператор подразумевается
  // равенством — тем же, что подставляет окно выборки (shared/answerFilter.ts).
  const op = equalsOp(block.type)
  const rows: BarRow[] = ordered.map((b) => {
    const active = conditions.some(
      (c) => c.blockId === block.blockId && c.op === op && c.value === b.key,
    )
    return {
      key: b.key,
      label: b.label,
      value: `${b.count} · ${percentText(b.count, base)}`,
      // Ширина полоски и названный процент — от ОДНОЙ базы: у распределения доля
      // осмысленна сама по себе («52 % выбрали Рекламу»).
      share: base > 0 ? b.count / base : 0,
      onSelect: () => onToggle({ blockId: block.blockId, op, value: b.key }),
      actionLabel: active ? `Убрать условие «${b.label}»` : `Оставить только «${b.label}»`,
      highlight: active,
    }
  })
  return <BarRows columns={{ label: 'Вариант', value: 'Ответы' }} rows={rows} />
}

// Последние ответы под вопросом — вместо доли заполнивших у текстовых типов.
// Полоска «заполнили 12 из 34» у открытого вопроса не говорит ничего, а сами
// ответы — говорят всё.
//
// Значений не больше десяти (потолок ставит сервер), дальше — окно со своей
// пагинацией.
function Samples({ block }: { block: BlockSummary }) {
  if (block.samples.length === 0) {
    return (
      <BarRows
        columns={{ label: 'Вопрос', value: 'Заполнили' }}
        rows={[
          {
            key: 'filled',
            label: block.label,
            value: `${block.answered} · ${percentText(block.answered, block.asked)}`,
            share: block.asked > 0 ? block.answered / block.asked : 0,
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

// Числовой вопрос: медиана главная, средняя рядом. Медиана — потому что у денег и
// возраста средняя живёт под выбросами: «сколько готовы тратить в месяц» давало
// среднее 19 934 ₽ при максимуме 148 200, и действия из этого числа не следует.
function NumberStats({ block }: { block: BlockSummary }) {
  if (!block.number) {
    return <p className="text-sm text-muted-foreground">На этот вопрос никто не ответил.</p>
  }
  const { avg, median, min, max } = block.number
  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {[
        ['Медиана', median],
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

// Шкала и звёзды: средняя, NPS у шкалы 0–10 и ряд средней. NPS — разность долей,
// поэтому подчиняется порогу малых выборок: «−100» по одному ответу владелец прочтёт
// как приговор форме. Ряд рисуется, когда непустых корзин хотя бы две — одна точка
// не линия.
function ScaleSummary({ block, scale }: { block: BlockSummary; scale: ScaleStats }) {
  const marks = block.buckets.map((b) => Number(b.key)).filter((n) => Number.isFinite(n))
  const min = marks.length > 0 ? Math.min(...marks) : 0
  const max = marks.length > 0 ? Math.max(...marks) : 5
  const filled = scale.trend.filter((p) => p.n > 0).length
  const showNps = scale.nps !== undefined && block.answered >= MIN_BASE

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
            <dd className="mt-0.5 text-xl font-bold tabular-nums">
              {signedFmt.format(scale.nps!)}
            </dd>
          </div>
        )}
      </dl>
      {showNps && <NpsGroups block={block} />}
      {filled >= 2 && <ScaleTrendChart points={scale.trend} step={scale.step} min={min} max={max} />}
    </div>
  )
}

// NPS — разность долей промоутеров и критиков, и без самих долей это число ни о чём
// не говорит: «+30» одинаково выходит и у формы с 40 % промоутеров и 10 % критиков,
// и у формы с 65 % и 35 %. Поэтому под индексом стоит полоса, из которой он собран
// (спека design/analytics-v3.md §6).
//
// Полоса, а не три числа в ряд: группы — это части одного целого, и их сумма равна
// ста процентам. Тремя отдельными величинами это приходилось складывать глазом.
//
// Границы групп — определение NPS для шкалы 0–10: критики 0–6, нейтралы 7–8,
// промоутеры 9–10. Считаются здесь, а не на сервере: это та же выборка под другим
// углом, а поле в контракте разрешило бы двум наборам чисел разъехаться.
//
// Тона — из категориального набора данных, а не светофор: «критик» это вид ответа,
// а не состояние формы, и красным он сообщал бы о поломке, которой нет
// (docs/DESIGN-SYSTEM.md, роли цвета).
const NPS_GROUPS: { title: string; from: number; to: number; color: string }[] = [
  { title: 'Промоутеры', from: 9, to: 10, color: 'var(--chart-1)' },
  { title: 'Нейтралы', from: 7, to: 8, color: 'var(--chart-3)' },
  { title: 'Критики', from: 0, to: 6, color: 'var(--chart-5)' },
]

function NpsGroups({ block }: { block: BlockSummary }) {
  const base = block.answered
  const groups = NPS_GROUPS.map((g) => ({
    ...g,
    count: block.buckets.reduce((sum, b) => {
      const mark = Number(b.key)
      return Number.isFinite(mark) && mark >= g.from && mark <= g.to ? sum + b.count : sum
    }, 0),
  }))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {groups.map((g) => (
          <div
            key={g.title}
            style={{ width: `${base > 0 ? (g.count / base) * 100 : 0}%`, backgroundColor: g.color }}
          />
        ))}
      </div>
      {/* Цвет всегда идёт ВМЕСТЕ с подписью, а не вместо неё. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {groups.map((g) => (
          <li key={g.title} className="flex items-center gap-1.5">
            <span
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: g.color }}
              aria-hidden="true"
            />
            <span>{g.title}</span>
            <span className="tabular-nums text-muted-foreground">
              {percentText(g.count, base)} · {g.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
