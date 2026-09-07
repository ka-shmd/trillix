import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type FormFunnel } from '../../entities/funnel'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { funnelQueryOptions } from '../../features/funnel/queries'
import { CompletionCards } from '../../features/insights/Cards'
import { FunnelChart } from '../../features/insights/lazyCharts'
import { worstStep } from '../../features/insights/metrics'
import { pluralPeople } from '../../shared/format'
import { ApiError } from '../../shared/api/errors'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'

// Вкладка «Отвалы» (/forms/$slug/insights/drop-offs): на каком вопросе люди уходят.
//
// Шаг 6 дал владельцу дробь «187 просмотров → 12 ответов»: она говорит, что форма
// теряет людей, но молчит, где. Этот экран отвечает на «где» — и из него следует
// конкретное действие: убрать вопрос или сделать необязательным.
//
// Свой маршрут, а не секция сводки (решение владельца): другой источник данных
// (визиты, не ответы), своё пустое состояние и свои загрузка/ошибка — на общей
// странице получились бы два спиннера и две коробки ошибки.
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/drop-offs')({
  component: FunnelPage,
})

function FunnelPage() {
  // URL адресует форму slug'ом; UUID для запроса берём из загруженной формы — как на
  // страницах ответов и сводки.
  const { slug } = Route.useParams()
  const { period } = Route.useSearch()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const funnel = useQuery({
    ...funnelQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })

  // Карточки здесь СВОИ: вкладка про прохождение формы, а не про трафик. «Начали
  // отвечать» и «Завершили» — это верх воронки, поэтому они и приезжают из неё.
  const cards = (
    <CompletionCards
      slug={slug}
      period={period}
      started={funnel.data ? funnel.data.visits - funnel.data.leftBeforeFirst : undefined}
      completed={funnel.data?.submitted}
      pending={funnel.isPending}
    />
  )

  // Воронка закрыта тарифом. Показываем НАСТОЯЩЕЕ число не дошедших — оно уже
  // загружено вместе с формой (визиты собираются для всех планов, гейт стоит на
  // показе разбивки). Плашка, рекламирующая пустоту, не продаёт ничего. Карточек
  // над ней нет: они считаются из воронки, которой мы не получили.
  if (funnel.isError && funnel.error instanceof ApiError && funnel.error.code === 'plan_required') {
    const notFinished = (form.data?.visitCount ?? 0) - (form.data?.visitSubmittedCount ?? 0)
    return (
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
    )
  }

  return (
    <div className="flex flex-col gap-12">
      {cards}

      <Section title="Где уходят" description={funnelHint(funnel.data)}>
        {funnel.isPending ? (
          <LoadingRows rows={3} />
        ) : funnel.isError ? (
          <ErrorState title="Не удалось посчитать воронку." onRetry={() => funnel.refetch()} />
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
            <FunnelChart funnel={funnel.data} />
            {funnel.data.leftBeforeFirst > 0 && (
              <p className="text-sm text-muted-foreground">
                {funnel.data.leftBeforeFirst} ушли, не тронув ни одного вопроса.
              </p>
            )}
            {/* Честная оговорка на самом экране, а не только в документации: пока
                форма — одна длинная страница, «дошёл» означает «коснулся поля».
                Проскроллившего и передумавшего не видно, и владелец должен знать
                это, читая числа. */}
            <p className="text-xs text-muted-foreground">
              «Дошёл до вопроса» считается по касанию поля: человек, который пролистал форму и ушёл,
              ничего не заполнив, в шаги не попадает. С приходом многостраничных форм счёт станет
              точнее.
            </p>
          </>
        )}
      </Section>
    </div>
  )
}

// Пояснение раздела называет САМЫЙ ПРОБЛЕМНЫЙ шаг — то, ради чего на экран и
// заходят. Разбор по каждому шагу остаётся в тултипе его полоски.
function funnelHint(funnel: FormFunnel | undefined): string {
  if (!funnel) return 'Сколько человек дошло до каждого вопроса и где они останавливаются.'
  const worst = worstStep(funnel.steps)
  if (!worst) return 'Ни на одном вопросе люди пока не останавливались.'
  return `Больше всего теряется на шаге «${worst.label}» — ${worst.dropped} ${pluralPeople(worst.dropped)}.`
}
