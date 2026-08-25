import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../forms/queries'
import { submissionsCountQueryOptions } from '../submissions/queries'
import { visitInsightsQueryOptions } from './queries'
import { formatDuration } from '../../shared/format'
import { type Period } from '../../shared/period'

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

// Card — общий примитив: заголовок и число.
export function Card({
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

// VisitCards — трафик: вкладки «Ответы» и «Визиты».
//
// Числа приезжают ДВУМЯ запросами, и это не недосмотр: визиты и ответы —
// независимые множества из разных модулей (docs/ANALYTICS.md §1), а сведение их в
// один ответ рано или поздно кончилось бы делением одного на другое.
export function VisitCards({ slug, period }: { slug: string; period: Period }) {
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
  const measured = visits.data !== undefined && visits.data.timedVisits > 0

  return (
    <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card title="Визиты" value={visits.data?.visits} pending={visits.isPending} />
      <Card title="Ответы" value={answers.data?.submissions} pending={answers.isPending} />
      <Card title="Уникальные" value={visits.data?.uniqueVisitors} pending={visits.isPending} />
      <Card
        title="Длительность визита"
        value={measured ? formatDuration(visits.data.medianDurationSec) : undefined}
        pending={visits.isPending}
      />
    </div>
  )
}

// CompletionCards — прохождение формы: вкладка «Отвалы».
//
// «Начали отвечать» и «Завершили» приходят из воронки (это её же верх), а
// длительность завершения — из счётчиков визитов: там она считается тем же сканом,
// что и остальные, и отдельный запрос был бы походом за числом из той же выборки.
export function CompletionCards({
  slug,
  period,
  started,
  completed,
  pending,
}: {
  slug: string
  period: Period
  started: number | undefined
  completed: number | undefined
  pending: boolean
}) {
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const visits = useQuery({
    ...visitInsightsQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })
  const measured = visits.data !== undefined && visits.data.timedCompletions > 0

  // Доля считается от НАЧАВШИХ, а не от всех визитов: «дошли до конца» отвечает на
  // вопрос про форму, а не про трафик. Нулевой знаменатель даёт прочерк, а не 0 %:
  // «никто не начинал» и «никто не дошёл» — разные новости.
  const rate =
    started !== undefined && completed !== undefined && started > 0
      ? `${Math.round((completed / started) * 100)} %`
      : undefined

  return (
    <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card title="Начали отвечать" value={started} pending={pending} />
      <Card title="Завершили" value={completed} pending={pending} />
      <Card title="Доля завершивших" value={rate} pending={pending} />
      <Card
        title="Длительность заполнения"
        value={measured ? formatDuration(visits.data.completionDurationSec) : undefined}
        pending={visits.isPending}
      />
    </div>
  )
}
