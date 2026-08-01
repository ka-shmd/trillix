import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type PlanFeature } from '../../entities/plan'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { planSnapshotQueryOptions } from '../../features/plan/queries'
import { formatDate } from '../../shared/format'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

// Страница «Тариф» (/settings/plan): какой план у воркспейса, сколько израсходовано
// и что даёт платный.
//
// Денег страница НЕ принимает: платёжного провайдера в проекте нет (нет ИП, оферты
// и договора — фаза платежей отдельная). Кнопка ведёт на заглушку, и это сказано
// вслух: кнопка «Оплатить», которая молча ничего не делает, хуже её отсутствия.
export const Route = createFileRoute('/_app/settings/plan')({
  component: PlanPage,
})

function PlanPage() {
  // В MVP у пользователя один личный воркспейс — он же платёжный якорь аккаунта.
  const workspaces = useQuery(workspacesQueryOptions)
  const workspaceId = workspaces.data?.[0]?.id
  const plan = useQuery({
    ...planSnapshotQueryOptions(workspaceId ?? ''),
    enabled: workspaceId !== undefined,
  })

  if (plan.isPending) {
    return <p className="text-sm text-muted-foreground">Загрузка тарифа…</p>
  }
  if (plan.isError) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
        <p className="mb-3 text-sm">Не удалось загрузить тариф.</p>
        <Button variant="outline" size="sm" onClick={() => plan.refetch()}>
          Повторить
        </Button>
      </div>
    )
  }

  const { planTitle, periodEnd, features } = plan.data
  const quotas = features.filter((f) => f.kind === 'quota')
  const toggles = features.filter((f) => f.kind === 'toggle')

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <section>
        <h1 className="text-lg font-medium">Тариф</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Текущий план — <span className="text-foreground">{planTitle}</span>.
        </p>
      </section>

      {quotas.length > 0 && (
        <section className="flex flex-col gap-4">
          {quotas.map((f) => (
            <QuotaRow key={f.key} feature={f} periodEnd={periodEnd} />
          ))}
        </section>
      )}

      {toggles.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Возможности</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {toggles.map((f) => (
              <li key={f.key} className="flex items-center justify-between gap-3">
                <span className={f.allowed ? undefined : 'text-muted-foreground'}>{f.title}</span>
                <span className={f.allowed ? 'text-sm' : 'text-sm text-muted-foreground'}>
                  {f.allowed ? 'включено' : 'на платном тарифе'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border p-4">
        <p className="text-sm">
          Оплата тарифов ещё не подключена — мы её готовим. Ничего не потеряется: все
          собранные ответы сохраняются независимо от плана.
        </p>
        <Button className="mt-3" size="sm" disabled>
          Перейти на платный тариф
        </Button>
      </section>
    </div>
  )
}

// QuotaRow — числовой лимит: «87 из 100» плюс полоса. Безлимит (limit === null)
// полосы не имеет: рисовать заполненность у бесконечности нечем.
function QuotaRow({ feature, periodEnd }: { feature: PlanFeature; periodEnd: string }) {
  const { title, used, limit } = feature

  if (limit === null) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span>{title}</span>
          <span className="text-muted-foreground">без ограничения</span>
        </div>
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
      <p className="mt-1 text-xs text-muted-foreground">
        Расход обнулится {formatDate(periodEnd)}.
        {exhausted &&
          ` Ответы сверх лимита продолжают приниматься и сохраняться — они скрыты до перехода на тариф, который их вмещает.`}
      </p>
    </div>
  )
}
