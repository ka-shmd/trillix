import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type PlanFeature } from '../../entities/plan'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { planSnapshotQueryOptions } from '../../features/plan/queries'
import { formatDate } from '../../shared/format'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { Section } from '../../shared/page/Section'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

// Страница «Тариф» (/w/{slug}/plan): какой план у пространства, сколько израсходовано
// и что даёт платный.
//
// Денег страница НЕ принимает: платёжного провайдера в проекте нет (нет ИП, оферты
// и договора — фаза платежей отдельная). Кнопка ведёт на заглушку, и это сказано
// вслух: кнопка «Оплатить», которая молча ничего не делает, хуже её отсутствия.
export const Route = createFileRoute('/_app/w/$workspaceSlug/plan')({
  component: PlanPage,
})

function PlanPage() {
  // Тариф принадлежит ПРОСТРАНСТВУ (квоты считаются по нему, `workspace_usage`),
  // поэтому пространство стоит в ПУТИ. Пока страница жила по адресу
  // `/settings/plan`, она читала пространство из `?w=`, а ни одна из семи ссылок на
  // неё параметра не несла — то есть тариф командного пространства был недостижим
  // из интерфейса вовсе (спека `docs/design/cabinet-navigation.md` §2).
  //
  // Перевод slug'а в id для запроса делает useCurrentWorkspace.
  const workspaces = useQuery(workspacesQueryOptions)
  const workspace = useCurrentWorkspace()
  const workspaceCrumb = useWorkspaceCrumb()
  const plan = useQuery({
    ...planSnapshotQueryOptions(workspace?.id ?? ''),
    enabled: workspace !== undefined,
  })

  const quotas = plan.data?.features.filter((f) => f.kind === 'quota') ?? []
  const toggles = plan.data?.features.filter((f) => f.kind === 'toggle') ?? []

  // Колонка, крошки и заголовок стоят ВНЕ ветвления состояний: экран, у которого на
  // загрузке нет ни пути в баре, ни имени, читается как чужая страница, а не как
  // «этот же раздел, данные едут» (DESIGN-SYSTEM §1).
  return (
    <PageContainer>
      <PageCrumbs items={[workspaceCrumb, 'Тариф']} />
      <PageHeader
        title="Тариф"
        description={
          plan.data ? (
            <>
              Текущий план — <span className="text-foreground">{plan.data.planTitle}</span>.
            </>
          ) : (
            'Что входит в план пространства и сколько из него израсходовано.'
          )
        }
      />

      <div className="mt-8 flex flex-col gap-12">
        {/* Сбой списка пространств разбирается ОТДЕЛЬНО: без него пространство
            остаётся undefined, запрос тарифа не включается, а выключенный запрос в
            TanStack v5 вечно `pending` — страница показывала бы загрузку без конца и
            без кнопки повтора. Найдено ревью фазы 17. */}
        {workspaces.isError ? (
          <ErrorState
            title="Не удалось загрузить пространство."
            onRetry={() => void workspaces.refetch()}
            retryLabel="Повторить"
          />
        ) : plan.isError ? (
          <ErrorState
            title="Не удалось загрузить тариф."
            onRetry={() => void plan.refetch()}
            retryLabel="Повторить"
          />
        ) : plan.isPending ? (
          <LoadingRows rows={3} />
        ) : (
          <>
            {quotas.length > 0 && (
              <Section title="Расход" description="Считается по пространству, а не по аккаунту.">
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
