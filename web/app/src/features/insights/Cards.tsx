import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../forms/queries'
import { submissionsCountQueryOptions } from '../submissions/queries'
import { visitInsightsQueryOptions } from './queries'
import { conversionText, countDelta, durationDelta, rateDelta } from './metrics'
import { formatDuration } from '../../shared/format'
import { previousPeriodLabels, type Period } from '../../shared/period'

// Полоса карточек над вкладками аналитики.
//
// Наборов ДВА, и они не пересекаются: «Ответы» и «Визиты» смотрят на трафик
// (сколько пришло и кто), «Отвалы» — на прохождение формы (сколько начали и
// дошли). Общая полоса на все три вкладки означала бы, что на «Отвалах» половина
// чисел не о том, на что человек пришёл смотреть.
//
// Границы метрик на экран не выносятся (docs/ANALYTICS.md §8.8): владелец читает
// свои данные, а не отчёт об устройстве счётчика. Отличие «данных нет» от нуля
// показывается прочерком.

// Card — общий примитив: заголовок и число. Подложка, а не рамка: четыре
// обведённых прямоугольника в ряд читаются как четыре объекта на странице, тогда
// как это одна полоса состояния (docs/DESIGN-SYSTEM.md, «плоскость вместо рамки»).
// Число — кегль заголовка раздела (20/700), а не свой: полоса стоит НАД разделами и
// не должна их перекрикивать.
//
// Разметка — dt/dd внутри dl полосы, а не заголовок с абзацем: подпись карточки это
// имя величины, а не раздел страницы. Заголовком она попадала в оглавление
// скринридера вперемешку с настоящими разделами.
//
// delta — изменение к прошлому окну той же длины (metrics.ts: countDelta и соседи),
// compareLabel — с чем сравнили («к прошлым 7 дням»). Нет изменения — нет и строки.
export function Card({
  title,
  value,
  pending,
  delta,
  compareLabel,
}: {
  title: string
  value: number | string | undefined
  pending: boolean
  delta?: string | null
  compareLabel?: string
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-4 py-3">
      <dt className="text-sm text-muted-foreground">{title}</dt>
      <dd className="mt-0.5 text-xl font-bold tabular-nums">
        {pending ? <span className="text-muted-foreground">…</span> : (value ?? '—')}
        {!pending && delta && compareLabel && (
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
            {delta} {compareLabel}
          </span>
        )}
      </dd>
    </div>
  )
}

function compareLabelFor(period: Period): string | undefined {
  return period === 'all' ? undefined : previousPeriodLabels[period]
}

// VisitCards — трафик: вкладки «Ответы» и «Визиты».
//
// Числа приезжают ДВУМЯ запросами, и это не недосмотр: визиты и ответы —
// независимые множества из разных модулей (docs/ANALYTICS.md §1), а сведение их в
// один ответ рано или поздно кончилось бы делением одного на другое.
//
// segment — сегмент визита «Сводки»: полоса обязана считать ту же совокупность, что
// разделы под ней. Без него полоса над сегментированной сводкой говорила бы о всём
// трафике формы, стоя в тридцати пикселях от чисел по сегменту.
//
// answers — число ответов, когда сегмент выбран: ручка счётчика ответов сегмента не
// знает, а «Сводка» это число уже получила со сводкой и второй скан ради одной
// карточки не нужен. undefined — «неизвестно» (выборка ниже порога k), прочерк.
export function VisitCards({
  slug,
  period,
  segment,
  answers,
}: {
  slug: string
  period: Period
  segment?: string
  answers?: { value: number | undefined; pending: boolean }
}) {
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const visits = useQuery({
    ...visitInsightsQueryOptions(formId ?? '', period, segment),
    enabled: formId !== undefined,
  })
  const count = useQuery({
    ...submissionsCountQueryOptions(formId ?? '', period),
    enabled: formId !== undefined && answers === undefined,
  })
  const measured = visits.data !== undefined && visits.data.timedVisits > 0
  const v = visits.data
  const prev = v?.previous
  const label = compareLabelFor(period)

  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card
        title="Визиты"
        value={v?.visits}
        pending={visits.isPending}
        delta={v && countDelta(v.visits, prev?.visits)}
        compareLabel={label}
      />
      <Card
        title="Ответы"
        value={answers ? answers.value : count.data?.submissions}
        pending={answers ? answers.pending : count.isPending}
        // Сравнения с прошлым окном у числа из сводки нет: сводка считает одно окно.
        delta={answers ? undefined : count.data && countDelta(count.data.submissions, count.data.previous)}
        compareLabel={label}
      />
      <Card
        title="Уникальные"
        value={v?.uniqueVisitors}
        pending={visits.isPending}
        delta={v && countDelta(v.uniqueVisitors, prev?.uniqueVisitors)}
        compareLabel={label}
      />
      <Card
        title="Длительность визита"
        value={measured ? formatDuration(visits.data.medianDurationSec) : undefined}
        pending={visits.isPending}
        delta={
          v &&
          durationDelta(
            { sec: v.medianDurationSec, samples: v.timedVisits },
            prev && { sec: prev.medianDurationSec, samples: prev.timedVisits },
          )
        }
        compareLabel={label}
      />
    </dl>
  )
}

// CompletionCards — прохождение формы: вкладка «Отвалы».
//
// «Начали отвечать» и «Завершили» приходят из воронки (это её же верх), а
// длительность завершения — из счётчиков визитов: там она считается тем же сканом,
// что и остальные, и отдельный запрос был бы походом за числом из той же выборки.
//
// segment — сегмент «Отвалов»: длительность считается по тем же визитам, что воронка.
export function CompletionCards({
  slug,
  period,
  segment,
  started,
  completed,
  pending,
}: {
  slug: string
  period: Period
  segment?: string
  started: number | undefined
  completed: number | undefined
  pending: boolean
}) {
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const visits = useQuery({
    ...visitInsightsQueryOptions(formId ?? '', period, segment),
    enabled: formId !== undefined,
  })
  const measured = visits.data !== undefined && visits.data.timedCompletions > 0

  // Доля считается от НАЧАВШИХ, а не от всех визитов: «дошли до конца» отвечает на
  // вопрос про форму, а не про трафик. Нулевой знаменатель даёт прочерк, а не 0 %:
  // «никто не начинал» и «никто не дошёл» — разные новости. Ниже порога малых выборок
  // — «N из M», а не процент.
  const rate =
    started !== undefined && completed !== undefined && started > 0
      ? conversionText(completed, started)
      : undefined

  // Прошлое окно — из счётчиков визитов: воронку за прошлое окно ради четырёх чисел
  // никто не считает, а «начали» и «отправили» там те же.
  const prev = visits.data?.previous
  const label = compareLabelFor(period)

  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card
        title="Начали отвечать"
        value={started}
        pending={pending}
        delta={started === undefined ? null : countDelta(started, prev?.started)}
        compareLabel={label}
      />
      <Card
        title="Завершили"
        value={completed}
        pending={pending}
        delta={completed === undefined ? null : countDelta(completed, prev?.submitted)}
        compareLabel={label}
      />
      <Card
        title="Доля завершивших"
        value={rate}
        pending={pending}
        delta={
          started === undefined || completed === undefined
            ? null
            : rateDelta(
                { part: completed, base: started },
                prev && { part: prev.submitted, base: prev.started },
              )
        }
        compareLabel={label}
      />
      <Card
        title="Длительность заполнения"
        value={measured ? formatDuration(visits.data.completionDurationSec) : undefined}
        pending={visits.isPending}
        delta={
          visits.data &&
          durationDelta(
            { sec: visits.data.completionDurationSec, samples: visits.data.timedCompletions },
            prev && { sec: prev.completionDurationSec, samples: prev.timedCompletions },
          )
        }
        compareLabel={label}
      />
    </dl>
  )
}
