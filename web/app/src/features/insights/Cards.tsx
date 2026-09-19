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
// ПОДПИСЬ — В ОДНУ СТРОКУ, и это требование к слову, а не к вёрстке. Перенос
// подписи опускает число ниже соседних, и ряд из четырёх величин перестаёт
// читаться как ряд: так «Длительность заполнения» роняла своё число на строку
// вниз. Не влезает — переименовать.
//
// delta — изменение к прошлому окну той же длины (metrics.ts: countDelta и
// соседи). Нет изменения — нет и приписки.
//
// Изменение стоит В СТРОКУ с числом, а с чем сравнили — ОДНОЙ подписью под всей
// полосой. Раньше «к прошлым 7 дням» повторялось в каждой из четырёх карточек:
// на 12-м кегле оно помещалось, на положенном шкалой 14-м стало переноситься, и
// полоса из четырёх величин превратилась в четыре двухстрочных абзаца об одном и
// том же. Повторять базу сравнения четыре раза незачем — она одна.
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
    <div className="rounded-lg bg-muted/50 px-4 py-3">
      <dt className="truncate text-sm text-muted-foreground">{title}</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xl font-bold tabular-nums">
        <span>{pending ? <span className="text-muted-foreground">…</span> : (value ?? '—')}</span>
        {!pending && delta && (
          <span className="text-sm font-normal text-muted-foreground">{delta}</span>
        )}
      </dd>
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
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
