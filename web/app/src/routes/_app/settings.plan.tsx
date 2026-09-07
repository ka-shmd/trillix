import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type PlanFeature } from '../../entities/plan'
import { accountPlanQueryOptions } from '../../features/plan/queries'
import { humanError } from '../../shared/api/errors'
import { formatDate } from '../../shared/format'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { Section } from '../../shared/page/Section'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

// Страница «Тариф» (/settings/plan): какой план у АККАУНТА, что он даёт, сколько
// израсходовано.
//
// СТРАНИЦА АККАУНТНАЯ, А НЕ ПРОСТРАНСТВЕННАЯ (решение владельца 2026-09-06, ADR
// §10). Платит человек: один купленный план накрывает все его пространства, включая
// заведённые завтра. Пока страница жила по адресу пространства, она на каждом
// показывала свой остаток сообщений ассистенту — и обещала этим тариф, которого у
// пространства нет.
//
// ВОРКСПЕЙС-КВОТ ЗДЕСЬ НЕТ ВОВСЕ (решение владельца там же): ни списком пространств,
// ни суммой. Страница отвечает на один вопрос — «за что я плачу», — а расход
// пространства это вопрос про пространство. Следствие названо вслух в BILLING §12:
// включённый лимит ответов не виден в кабинете до тех пор, пока в него не упрутся.
//
// Денег страница НЕ принимает: платёжного провайдера в проекте нет (нет ИП, оферты
// и договора — фаза платежей отдельная). Кнопка ведёт на заглушку, и это сказано
// вслух: кнопка «Оплатить», которая молча ничего не делает, хуже её отсутствия.
export const Route = createFileRoute('/_app/settings/plan')({
  component: PlanPage,
})

function PlanPage() {
  const plan = useQuery(accountPlanQueryOptions())

  const quotas = plan.data?.features.filter((f) => f.kind === 'quota') ?? []
  const toggles = plan.data?.features.filter((f) => f.kind === 'toggle') ?? []

  // Колонка, крошки и заголовок стоят ВНЕ ветвления состояний: экран, у которого на
  // загрузке нет ни пути в баре, ни имени, читается как чужая страница, а не как
  // «этот же раздел, данные едут» (DESIGN-SYSTEM §1).
  return (
    <PageContainer>
      <PageCrumbs items={['Тариф']} />
      <PageHeader
        title="Тариф"
        description={
          plan.data ? (
            <>
              Текущий план — <span className="text-foreground">{plan.data.planTitle}</span>.
            </>
          ) : (
            'Что входит в ваш план и сколько из него израсходовано.'
          )
        }
      />

      <div className="mt-8 flex flex-col gap-12">
        {plan.isError ? (
          <ErrorState
            title={humanError(plan.error, 'Не удалось загрузить тариф.')}
            onRetry={() => void plan.refetch()}
            retryLabel="Повторить"
          />
        ) : plan.isPending ? (
          <LoadingRows rows={3} />
        ) : (
          <>
            {quotas.length > 0 && (
              <Section title="Расход" description="Считается по аккаунту целиком.">
                <div className="flex flex-col gap-4">
                  {quotas.map((f) => (
                    <QuotaRow key={f.key} feature={f} periodEnd={plan.data.periodEnd} />
                  ))}
                </div>
              </Section>
            )}

            {toggles.length > 0 && (
              <Section title="Возможности">
                <ul className="flex flex-col gap-1 text-sm">
                  {toggles.map((f) => (
                    <li key={f.key} className="flex items-center justify-between gap-3">
                      <span className={f.allowed ? undefined : 'text-muted-foreground'}>
                        {f.title}
                      </span>
                      <span className={f.allowed ? 'text-sm' : 'text-sm text-muted-foreground'}>
                        {f.allowed ? 'включено' : 'на платном тарифе'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Оплата">
              <p className="text-sm">
                Оплата тарифов ещё не подключена — мы её готовим. Ничего не потеряется: все
                собранные ответы сохраняются независимо от плана.
              </p>
              <Button className="self-start" size="sm" disabled>
                Перейти на платный тариф
              </Button>
            </Section>
          </>
        )}
      </div>
    </PageContainer>
  )
}

// QuotaRow — числовой лимит: «87 из 100» плюс полоса. Безлимит (limit === null)
// полосы не имеет: рисовать заполненность у бесконечности нечем.
function QuotaRow({ feature, periodEnd }: { feature: PlanFeature; periodEnd: string }) {
  const { key, title, used, limit } = feature
  // ПЕРИОД ЕСТЬ НЕ У ВСЯКОЙ КВОТЫ. Сообщения ассистенту копятся за месяц и обнуляются
  // первого числа; число пространств — это «сколько занято сейчас», и обещание
  // «обнулится 1 октября» было бы про него прямой неправдой (внутри — Meter каталога,
  // здесь — его отражение).
  const periodic = key === 'ai_generations'

  if (limit === null) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{title}</span>
        <span className="text-muted-foreground">без ограничения</span>
      </div>
    )
  }

  const percent = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100))
  const exhausted = used >= limit

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{title}</span>
        <span className={exhausted ? 'text-destructive' : 'text-muted-foreground'}>
          {used} из {limit}
        </span>
      </div>
      <Progress value={percent} className="mt-2" />
      {periodic && (
        <p className="mt-1 text-xs text-muted-foreground">
          Расход обнулится {formatDate(periodEnd)}.
        </p>
      )}
    </div>
  )
}
