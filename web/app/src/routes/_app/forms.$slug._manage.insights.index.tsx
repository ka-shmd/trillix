import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type FormFunnel } from '../../entities/funnel'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { funnelQueryOptions } from '../../features/funnel/queries'
import { InsightCards } from '../../features/insights/Cards'
import { ScopeBar } from '../../features/insights/ScopeBar'
import { VersionsTable } from '../../features/insights/VersionsTable'
import { versionStatsQueryOptions } from '../../features/insights/queries'
import { Funnel } from '../../features/insights/Funnel'
import { funnelRows, funnelSteps, worstStep } from '../../features/insights/metrics'
import { pluralPeople } from '../../shared/format'
import { type Period } from '../../shared/period'
import { segmentFromSearch } from '../../shared/segment'
import { ApiError } from '../../shared/api/errors'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'

// Вкладка «Обзор» (/forms/$slug/insights) — ПЕРВЫЙ экран аналитики: как работает
// форма и где она теряет людей (спека design/analytics-v3.md §2, §4).
//
// Шаг 6 дал владельцу дробь «187 просмотров → 12 ответов»: она говорит, что форма
// теряет людей, но молчит, где. Этот экран отвечает на «где» — и из него следует
// конкретное действие: убрать вопрос или сделать необязательным.
//
// Воронка открывает раздел, а распределения ответов идут третьей вкладкой
// (решение владельца 2026-09-19): пока форма теряет людей, содержание ответов
// вторично. Адрес /insights/drop-offs редиректит сюда — у владельца на него
// закладки.
//
// Экран стоит на INDEX-маршруте раздела, а не на своём пути: у «Обзора» нет адреса
// отдельно от «Аналитики». Index, редиректящий на вкладку, — это раздел вовсе без
// собственного экрана.
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
  // Выборка «Обзора» — только по визиту: воронку сервер по ответам не режет, и
  // предлагать здесь условия по ответам значило бы обещать несуществующее.
  const picker = formId && (
    <ScopeBar formId={formId} period={period} segment={segment} onSegment={setSegment} />
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
          // Абзаца «N ушли, не тронув ни одного вопроса» под воронкой больше нет:
          // это потеря первой ступени, и теперь она написана под её же полоской.
          <Funnel
            rows={funnelRows(funnel.data)}
            base={funnel.data.visits}
            worstKey={worstStep(funnelSteps(funnel.data))?.key}
          />
        )}
      </Section>

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

// Пояснение раздела называет САМЫЙ ПРОБЛЕМНЫЙ шаг — то, ради чего на экран и
// заходят. ЧИСЛА оно не повторяет: шаг подсвечен в самой воронке, и его потеря
// написана под его же полоской. Пока их печатали и здесь, одна и та же дробь
// стояла на экране дважды в двух шрифтах.
function funnelHint(funnel: FormFunnel | undefined): string {
  const general = 'Сколько человек дошло до каждого шага и где они останавливаются.'
  if (!funnel) return general
  const steps = funnelSteps(funnel)
  // У многостраничной формы шаг — страница, и внутри неё есть свои вопросы.
  // Раскрытие строки ничем, кроме шеврона, себя не выдаёт, поэтому о нём сказано
  // словом: это единственный путь к разбору страницы.
  const inside = funnel.pages.length > 0 ? ' Страница раскрывается щелчком — внутри её вопросы.' : ''
  const worst = worstStep(steps)
  if (worst) return `Чаще всего уходят на шаге «${worst.label}» — он выделен ниже.${inside}`
  // Отвалы есть, но все на шагах ниже порога малых выборок: назвать худший нельзя, а
  // «никто не останавливался» было бы неправдой.
  if (steps.some((s) => s.dropped > 0)) return general + inside
  return 'Ни на одном шаге люди пока не останавливались.' + inside
}
