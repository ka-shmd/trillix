import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { type BlockSummary } from '../../entities/summary'
import { BarRows, type BarRow } from '../../features/insights/Breakdown'
import { VisitCards } from '../../features/insights/Cards'
import { percentOf } from '../../features/insights/metrics'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { BlockAnswersDialog } from '../../features/submissions/BlockAnswersDialog'
import { submissionsSummaryQueryOptions } from '../../features/submissions/queries'
import { formatDate, LOCALE, pluralAnswers } from '../../shared/format'
import { type Period } from '../../shared/period'
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
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/answers')({
  component: SummaryPage,
})

function SummaryPage() {
  // URL адресует форму slug'ом; UUID для запроса сводки берём из загруженной формы —
  // как на странице ответов.
  const { slug } = Route.useParams()
  const { period } = Route.useSearch()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const summary = useQuery({
    ...submissionsSummaryQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })

  const total = summary.data?.total ?? 0

  return (
    <div className="flex flex-col gap-12">
      <VisitCards slug={slug} period={period} />

      <Section
        title="Ответы по вопросам"
        description={
          summary.isSuccess && total > 0
            ? `${total} ${pluralAnswers(total)} за выбранный период`
            : 'Распределение ответов по каждому вопросу формы.'
        }
      >
        {summary.isPending ? (
          <LoadingRows rows={3} />
        ) : summary.isError ? (
          <ErrorState title="Не удалось посчитать сводку." onRetry={() => summary.refetch()} />
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
                formId={formId ?? ''}
                period={period}
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
  formId,
  period,
}: {
  block: BlockSummary
  total: number
  formId: string
  period: Period
}) {
  const [allOpen, setAllOpen] = useState(false)

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
      {block.kind === 'distribution' ? (
        <Distribution block={block} />
      ) : block.kind === 'number' ? (
        <NumberStats block={block} />
      ) : (
        <Samples block={block} />
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
          />
        </>
      )}
    </article>
  )
}

// База процента: обычно доля от ответивших («52 % ответивших выбрали Рекламу»). У
// множественного выбора сумма долей поэтому больше 100 % — так и надо: человек
// выбирает несколько вариантов, и доля считается от людей, а не от галочек.
// Исключение — согласие: его «Нет» это те, кого спросили и кто не отметил, поэтому
// база — asked, и «Да» + «Нет» дают ровно 100 %.
function barBase(block: BlockSummary): number {
  return block.type === 'consent' ? block.asked : block.answered
}

function Distribution({ block }: { block: BlockSummary }) {
  if (block.buckets.length === 0) {
    return <p className="text-sm text-muted-foreground">В этом вопросе нет вариантов.</p>
  }
  const base = barBase(block)
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
