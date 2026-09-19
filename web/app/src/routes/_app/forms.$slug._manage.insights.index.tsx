import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { type FormFunnel } from '../../entities/funnel'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { funnelQueryOptions } from '../../features/funnel/queries'
import { InsightCards } from '../../features/insights/Cards'
import { SegmentPicker } from '../../features/insights/SegmentPicker'
import { VersionsTable } from '../../features/insights/VersionsTable'
import { versionStatsQueryOptions } from '../../features/insights/queries'
import { FunnelChart } from '../../features/insights/lazyCharts'
import {
  funnelRows,
  funnelSteps,
  pageQuestionRows,
  worstStep,
} from '../../features/insights/metrics'
import { pluralPeople } from '../../shared/format'
import { type Period } from '../../shared/period'
import { segmentFromSearch } from '../../shared/segment'
import { ApiError } from '../../shared/api/errors'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Вкладка «Обзор» (/forms/$slug/insights) — ПЕРВЫЙ экран аналитики: как работает
// форма и где она теряет людей (спека design/analytics-v3.md §2, §4).
//
// Шаг 6 дал владельцу дробь «187 просмотров → 12 ответов»: она говорит, что форма
// теряет людей, но молчит, где. Этот экран отвечает на «где» — и из него следует
// конкретное действие: убрать вопрос или сделать необязательным.
//
// Раньше это была третья вкладка «Отвалы», а раздел открывался распределениями
// ответов. Порядок перевёрнут решением владельца 2026-09-19: пока форма теряет
// людей, содержание ответов вторично. Старый адрес /insights/drop-offs редиректит
// сюда — у владельца на него закладки.
//
// Экран стоит на INDEX-маршруте раздела, а не на своём пути: у «Обзора» нет адреса
// отдельно от «Аналитики». Прежде index редиректил на вкладку — то есть у раздела
// не было собственного экрана вовсе.
//
// Сегмент (?segment=device:Телефон) — этой вкладки и «Ответов»: воронка, карточки и
// разрез версий считаются по визитам сегмента (спека design/analytics-v2.md §5.4).
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/')({
  // Необязательный ключ, а не «всегда есть, иногда undefined»: иначе каждая ссылка на
  // вкладку обязана была бы его называть.
  validateSearch: (search): { segment?: string } => {
    const segment = segmentFromSearch(search.segment)
    return segment ? { segment } : {}
  },
  component: OverviewPage,
})

function OverviewPage() {
  // URL адресует форму slug'ом; UUID для запроса берём из загруженной формы — как на
  // страницах ответов и сводки.
  const { slug } = Route.useParams()
  const { period, segment } = Route.useSearch()
  const navigate = Route.useNavigate()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const funnel = useQuery({
    ...funnelQueryOptions(formId ?? '', period, segment),
    enabled: formId !== undefined,
  })
  const setSegment = (next: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, segment: next }), replace: true })
  const picker = formId && (
    <SegmentPicker formId={formId} period={period} segment={segment} onChange={setSegment} />
  )

  // Полоса та же, что на «Сводке» и «Визитах» (спека design/analytics-v3.md §3):
  // её числа — Визиты → Начали → Отправили → Конверсия — это верх той же воронки,
  // что нарисована ниже, и они обязаны совпадать с ней, а не спорить.
  const cards = <InsightCards slug={slug} period={period} segment={segment} />

  // Воронка закрыта тарифом. Показываем НАСТОЯЩЕЕ число не дошедших — оно уже
  // загружено вместе с формой (визиты собираются для всех планов, гейт стоит на
  // показе разбивки). Плашка, рекламирующая пустоту, не продаёт ничего.
  //
  // Полоса карточек над плашкой ОСТАЁТСЯ: её четыре числа бесплатны на всех планах
  // (docs/ANALYTICS.md §9) и больше не считаются из воронки. Гейт закрывает разбор
  // по шагам, а не экран целиком.
  const planRequired =
    funnel.isError && funnel.error instanceof ApiError && funnel.error.code === 'plan_required'

  // С сегментом отказ по тарифу — про сегмент: сама воронка без него могла быть
  // открыта, и путь назад к ней — сброс сегмента.
  if (planRequired && segment) {
    return (
      <div className="flex flex-col gap-12">
        {picker}
        <EmptyState
          title="Сегменты закрыты тарифом"
          description="Разрез воронки по устройству, источнику, месту и версии формы доступен на тарифе с аналитикой."
          action={
            <Button asChild size="sm">
              <Link to="/settings/plan">Посмотреть тариф</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if (planRequired) {
    const notFinished = (form.data?.visitCount ?? 0) - (form.data?.visitSubmittedCount ?? 0)
    return (
      <div className="flex flex-col gap-12">
        {cards}
        <EmptyState
          title={
            notFinished > 0
              ? `Не дошли до конца формы: ${notFinished} ${pluralPeople(notFinished)}`
              : 'Воронка отвала'
          }
          description={
            notFinished > 0
              ? 'Откройте тариф с аналитикой, чтобы увидеть, на каких именно вопросах они уходят.'
              : 'Разбивка по вопросам доступна на тарифе с аналитикой. Визиты уже собираются — данные копятся и никуда не денутся.'
          }
          action={
            <Button asChild size="sm">
              <Link to="/settings/plan">Посмотреть тариф</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-col gap-6">
        {picker}
        {cards}
      </div>

      <Section title="Где уходят" description={funnelHint(funnel.data)}>
        {funnel.isPending ? (
          <LoadingRows rows={3} />
        ) : funnel.isError ? (
          <ErrorState title="Не удалось посчитать воронку." onRetry={() => funnel.refetch()} />
        ) : funnel.data.visits === 0 && segment ? (
          <EmptyState
            title="В этом сегменте визитов нет"
            description="За выбранный период никто не пришёл с таким значением. Выберите другое или сбросьте сегмент."
          />
        ) : funnel.data.visits === 0 ? (
          <EmptyState
            title="Просмотров пока нет"
            description="Поделитесь ссылкой на форму — как только её откроют, здесь появится, на каком вопросе люди уходят."
          />
        ) : funnel.data.steps.length === 0 ? (
          // Визиты есть, а вопросов нет: все вопросы формы удалены после сбора.
          // Объяснение, а не пустой экран — иначе выглядит как поломка.
          <EmptyState
            title="Воронке нечего показывать"
            description="В опубликованных версиях формы нет вопросов."
          />
        ) : (
          <>
            <FunnelChart rows={funnelRows(funnel.data)} base={funnel.data.visits} />
            {funnel.data.leftBeforeFirst > 0 && (
              <p className="text-sm text-muted-foreground">
                {funnel.data.leftBeforeFirst} ушли, не тронув ни одного вопроса.
              </p>
            )}
          </>
        )}
      </Section>

      {funnel.data && funnel.data.visits > 0 && funnel.data.pages.length > 0 && (
        <PageQuestions funnel={funnel.data} />
      )}

      {formId && <Versions formId={formId} period={period} segment={segment} />}
    </div>
  )
}

// Разрез по версиям формы: помогла ли правка. Раздел не рисуется, пока у формы одна
// версия с визитами, — сравнивать не с чем.
function Versions({
  formId,
  period,
  segment,
}: {
  formId: string
  period: Period
  segment: string | undefined
}) {
  const versions = useQuery(versionStatsQueryOptions(formId, period, segment))
  if (versions.isPending || versions.isError || versions.data.length < 2) return null
  return (
    <Section
      title="По версиям формы"
      description="Сколько визитов пришлось на каждую опубликованную версию и сколько из них закончились ответом."
    >
      <VersionsTable versions={versions.data} />
    </Section>
  )
}

// Вопросы одной страницы многостраничной формы. Выбор страницы — список, а не щелчок
// по полоске графика: полоска не кнопка, и с клавиатуры до неё не добраться. Сначала
// открыта страница, названная в пояснении воронки, — ради неё сюда и спускаются.
function PageQuestions({ funnel }: { funnel: FormFunnel }) {
  const [chosen, setChosen] = useState<string | null>(null)
  const worst = worstStep(funnelSteps(funnel))
  const fallback = worst ? worst.key : `page:${funnel.pages[0]!.key}`
  // Выбранной страницы может не оказаться в новом окне наблюдения — тогда снова
  // страница по умолчанию, а не пустой список.
  const value = chosen !== null && funnel.pages.some((p) => `page:${p.key}` === chosen) ? chosen : fallback
  // Ключ страницы '' (первая) Select не принимает — пустое значение у него значит
  // «ничего не выбрано». Отсюда префикс page: — тот же, что у строк воронки.
  const pageKey = value.slice('page:'.length)

  return (
    <Section
      title="Вопросы страницы"
      description="Сколько человек дошло до каждого вопроса выбранной страницы и где они остановились."
      action={
        <Select value={value} onValueChange={setChosen}>
          <SelectTrigger className="w-[220px]" aria-label="Страница">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {funnel.pages.map((p) => (
              <SelectItem key={p.key} value={`page:${p.key}`}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <FunnelChart rows={pageQuestionRows(funnel, pageKey)} base={funnel.visits} />
    </Section>
  )
}

// Пояснение раздела называет САМЫЙ ПРОБЛЕМНЫЙ шаг — то, ради чего на экран и
// заходят. Разбор по каждому шагу остаётся в тултипе его полоски.
function funnelHint(funnel: FormFunnel | undefined): string {
  const general = 'Сколько человек дошло до каждого шага и где они останавливаются.'
  if (!funnel) return general
  const steps = funnelSteps(funnel)
  const worst = worstStep(steps)
  if (worst) {
    return `Чаще всего уходят на шаге «${worst.label}»: ${worst.dropped} из ${worst.reached}, ${worst.percent} %.`
  }
  // Отвалы есть, но все на шагах ниже порога малых выборок: назвать худший нельзя, а
  // «никто не останавливался» было бы неправдой.
  if (steps.some((s) => s.dropped > 0)) return general
  return 'Ни на одном шаге люди пока не останавливались.'
}
