import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type BlockSummary } from '../../entities/summary'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { submissionsSummaryQueryOptions } from '../../features/submissions/queries'
import { pluralAnswers } from '../../shared/format'
import { Button } from '@/components/ui/button'

// Таб «Сводка» (/forms/$slug/summary): распределения, статистика чисел и доля
// заполнивших по каждому вопросу. Свой маршрут, а не локальный стейт табов
// (решение владельца): ссылка на сводку сохраняется в закладки, F5 её не сбрасывает,
// «Назад» браузера работает как ожидается. Шапка и табы — на оболочке _manage.
//
// Агрегат считает сервер — сюда приходят только счётчики (сырые ответы в браузер не
// выгружаются). Бары — на CSS: графических библиотек в проекте нет, список
// зависимостей заморожен (web/CLAUDE.md).
export const Route = createFileRoute('/_app/forms/$slug/_manage/summary')({
  component: SummaryPage,
})

function SummaryPage() {
  // URL адресует форму slug'ом; UUID для запроса сводки берём из загруженной формы —
  // как на странице ответов.
  const { slug } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const summary = useQuery({
    ...submissionsSummaryQueryOptions(formId ?? ''),
    enabled: formId !== undefined,
  })

  const total = summary.data?.total ?? 0

  return (
    <>
      {summary.isSuccess && (
        <p className="mb-6 text-sm text-muted-foreground">
          {total === 0 ? 'Пока нет ответов' : `${total} ${pluralAnswers(total)}`}
        </p>
      )}

      {summary.isPending ? (
        <p className="text-sm text-muted-foreground">Считаем сводку…</p>
      ) : summary.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Не удалось посчитать сводку.</p>
          <Button variant="outline" size="sm" onClick={() => summary.refetch()}>
            Повторить
          </Button>
        </div>
      ) : total === 0 ? (
        <div className="mx-auto mt-12 max-w-md text-center">
          <h2 className="text-lg font-medium">Ответов пока нет</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Опубликуйте форму и поделитесь ссылкой — сводка появится здесь.
          </p>
        </div>
      ) : summary.data.blocks.length === 0 ? (
        // Ответы есть, а вопросов нет: все вопросы формы удалены после сбора ответов.
        // Не пустой экран, а объяснение — иначе выглядит как поломка.
        <p className="text-sm text-muted-foreground">
          В опубликованных версиях формы нет вопросов — сводить нечего. Сами ответы
          доступны в таблице.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {summary.data.blocks.map((b) => (
            <BlockCard key={b.blockId} block={b} total={total} />
          ))}
        </div>
      )}
    </>
  )
}

function BlockCard({ block, total }: { block: BlockSummary; total: number }) {
  return (
    <article className="rounded-lg border p-5">
      <h2 className="font-medium">{block.label}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Ответили {block.answered} из {block.asked}
        {/* Знаменатель меньше числа ответов формы — значит вопрос видели не все: он за
            условием, на пропущенной странице или появился в поздней версии (фаза 21).
            Без этой оговорки владелец сравнивает «12 из 34» с «400 ответов» на карточке
            формы и читает расхождение как поломку. */}
        {block.asked < total && ` — вопрос показали ${block.asked} из ${total}`}
      </p>
      <div className="mt-4">
        {block.kind === 'distribution' ? (
          <Distribution block={block} />
        ) : block.kind === 'number' ? (
          <NumberStats block={block} />
        ) : (
          <FillRate block={block} />
        )}
      </div>
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
  return (
    <ul className="flex flex-col gap-3">
      {block.buckets.map((b) => (
        <li key={b.key}>
          <Bar label={b.label} count={b.count} base={base} />
        </li>
      ))}
    </ul>
  )
}

function FillRate({ block }: { block: BlockSummary }) {
  return <Bar label="Заполнили" count={block.answered} base={block.asked} />
}

// Один бар: подпись, счётчик с долей и полоска. Полоска декоративна (aria-hidden) —
// то же число уже прочитано текстом рядом, дублировать его скринридеру незачем.
function Bar({ label, count, base }: { label: string; count: number; base: number }) {
  // Ноль в знаменателе — вопрос, который никто не видел (версия без ответов):
  // показываем пустую полоску, а не NaN.
  const pct = base > 0 ? Math.round((count / base) * 100) : 0
  return (
    <>
      <div className="flex justify-between gap-4 text-sm">
        <span className="min-w-0 break-words">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {count} · {pct} %
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </>
  )
}

const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

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
          <dd className="mt-0.5 text-xl font-semibold tabular-nums">
            {numberFmt.format(value as number)}
          </dd>
        </div>
      ))}
    </dl>
  )
}
