import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../forms/queries'
import { visitInsightsQueryOptions } from './queries'
import { conversionText, countDelta, rateDelta } from './metrics'
import { previousPeriodLabels, type Period } from '../../shared/period'

// Полоса карточек над вкладками аналитики — ОДНА на все три (спека
// design/analytics-v3.md §3, решение владельца 2026-09-19).
//
// Прежде полос было две: «трафик» на «Сводке» и «Визитах», «прохождение» на
// «Отвалах». Довод был в том, что вкладки отвечают на разные вопросы. Цена
// оказалась выше довода, и обе половины цены видел владелец:
//
//   - конверсия не попала НИКУДА. На «Отвалах» стояла «доля завершивших» (от
//     начавших), в списке форм — конверсия (от визитов), и два разных числа об
//     одном и том же противоречили друг другу: 35 % против 26 %;
//   - «Ответы» (submissions) и «Завершили» (визиты с отметкой отправки) — разные
//     множества (docs/ANALYTICS.md §1) — стояли соседними карточками под похожими
//     подписями. На демо-форме это читалось как «341 просмотр, 10000 ответов,
//     конверсия 31 %».
//
// Отсюда состав: Визиты → Начали → Отправили → Конверсия. Это ОДНА воронка в
// четырёх числах, и каждое следующее — подмножество предыдущего. Все четыре
// приезжают одним запросом счётчиков визитов, поэтому разойтись между собой не
// могут в принципе.
//
// Числа ответов на полосе НЕТ. Оно живёт там, где на него смотрят: в пояснении
// раздела «Ответы по вопросам» и в таблице ответов. Асимметрия «ответы из
// submissions, процент по визитам» от этого не исчезает и остаётся верной — она
// просто перестаёт выноситься на экран двумя соседними карточками.
//
// Границы метрик на экран не выносятся (docs/ANALYTICS.md §8.8): владелец читает
// свои данные, а не отчёт об устройстве счётчика. Отличие «данных нет» от нуля
// показывается прочерком.

// Card — общий примитив: заголовок, число и изменение.
//
// ЧЕТЫРЕ КЛЕТКИ В ОДНОЙ РАМКЕ, а не четыре отдельные подложки (подача «В», решение
// владельца 2026-09-20). Подложка `bg-muted/50` — три процента серого: на экране её
// не видно вовсе, и полоса читалась не как блок, а как четыре обрывка текста в
// воздухе. Общая рамка с линиями между клетками говорит «это одна полоса
// состояния» без всякого цвета.
//
// ЧИСЛО — КЕГЛЬ ЗАГОЛОВКА ЭКРАНА (30/800). Это отмена прежнего решения («20/700,
// чтобы полоса не перекрикивала разделы»): не перекрикивала она настолько, что
// главные числа формы читались вровень с подписями разделов. Новый кегль не
// заводится — берётся существующая ступень шкалы (docs/DESIGN-SYSTEM.md §4) в новой
// роли. Заголовок экрана на странице один и стоит выше, так что двух смыслов у
// ступени на одном уровне не возникает.
//
// Разметка — dt/dd внутри dl полосы, а не заголовок с абзацем: подпись карточки это
// имя величины, а не раздел страницы. Заголовком она попадала в оглавление
// скринридера вперемешку с настоящими разделами.
//
// ПОДПИСЬ — В ОДНУ СТРОКУ, и это требование к слову, а не к вёрстке. Перенос
// подписи опускает число ниже соседних, и ряд из четырёх величин перестаёт
// читаться как ряд. Не влезает — переименовать.
export function Card({
  title,
  value,
  pending,
  delta,
}: {
  title: string
  value: number | string | undefined
  pending: boolean
  delta?: string | null
}) {
  return (
    <div className="bg-background px-5 py-4">
      <dt className="truncate text-sm text-muted-foreground">{title}</dt>
      <dd className="mt-0.5 text-3xl leading-tight font-extrabold tracking-tight tabular-nums">
        {pending ? <span className="text-muted-foreground">…</span> : (value ?? '—')}
      </dd>
      {/* Изменение — своей строкой под числом: приписка сбоку от 30-го кегля
          читалась бы его частью. Нет изменения — нет и строки, место под неё не
          резервируется: полоса выравнивается по верху. */}
      {!pending && delta && <p className="text-sm text-muted-foreground">{delta}</p>}
    </div>
  )
}

function compareLabelFor(period: Period): string | undefined {
  return period === 'all' ? undefined : previousPeriodLabels[period]
}

// Подпись под полосой: с чем сравнены приписки у чисел. Рисуется, только когда
// сравнение есть, — у «всего времени» прошлого окна не бывает.
function CompareNote({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">Изменение — {label}.</p>
}

// InsightCards — полоса всех вкладок аналитики.
//
// segment режет полосу так же, как разделы под ней: полоса над сегментированным
// экраном обязана считать ту же совокупность, иначе она говорит о всём трафике
// формы, стоя в тридцати пикселях от чисел по сегменту.
export function InsightCards({
  slug,
  period,
  segment,
}: {
  slug: string
  period: Period
  segment?: string
}) {
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const visits = useQuery({
    ...visitInsightsQueryOptions(formId ?? '', period, segment),
    enabled: formId !== undefined,
  })
  const v = visits.data
  const prev = v?.previous
  const label = compareLabelFor(period)

  // Конверсия = отправившие / визиты — ОДНО определение на весь продукт, то же
  // число, что в списке форм (решение владельца 2026-09-19). Ниже порога малых
  // выборок это «N из M», а не процент: «100 %» по двум визитам владелец прочтёт
  // закономерностью. Нулевой знаменатель даёт прочерк, а не «0 %»: «никто не
  // приходил» и «никто не отправил» — разные новости.
  const rate = v && v.visits > 0 ? conversionText(v.submitted, v.visits) : undefined

  return (
    <div className="flex flex-col gap-2">
      {/* gap-px на фоне рамки — линии между клетками одним цветом с рамкой, без
          отдельных border у каждой клетки (у соседей они удвоились бы). */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4">
        <Card
          title="Визиты"
          value={v?.visits}
          pending={visits.isPending}
          delta={v && countDelta(v.visits, prev?.visits)}
        />
        {/* «Начали» — тронули хотя бы один вопрос. Между «Визитами» и «Отправили»
            она стоит не для симметрии: без неё уход со страницы формы, которую даже
            не начали заполнять, неотличим от ухода с середины. */}
        <Card
          title="Начали"
          value={v?.started}
          pending={visits.isPending}
          delta={v && countDelta(v.started, prev?.started)}
        />
        <Card
          title="Отправили"
          value={v?.submitted}
          pending={visits.isPending}
          delta={v && countDelta(v.submitted, prev?.submitted)}
        />
        <Card
          title="Конверсия"
          value={rate}
          pending={visits.isPending}
          delta={
            v &&
            rateDelta(
              { part: v.submitted, base: v.visits },
              prev && { part: prev.submitted, base: prev.visits },
            )
          }
        />
      </dl>
      {label && v && <CompareNote label={label} />}
    </div>
  )
}
