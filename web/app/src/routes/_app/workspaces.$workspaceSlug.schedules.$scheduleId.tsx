import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { MoreHorizontal, Trash2 } from 'lucide-react'

import {
  scheduleQueryOptions,
  useDeleteSchedule,
  useUpdateSchedule,
} from '../../shared/schedules/queries'
import { ScheduleEditor } from '../../features/schedules/ScheduleEditor'
import { BlocksSection } from '../../features/schedules/BlocksSection'
import { UpcomingSection } from '../../features/schedules/UpcomingSection'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { humanError } from '../../shared/api/errors'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Страница одного расписания: правило приёма, параметры, исключения, занятое время
// и ближайшие записи.
//
// Расписание адресуется ID, а не slug'ом: slug'ов у него нет — публичной сущностью
// оно не является, наружу уезжает только свободное время формы. Пространство при этом
// стоит в пути (см. соседний index): так адрес не может умолчать, чьё это расписание.
export const Route = createFileRoute('/_app/workspaces/$workspaceSlug/schedules/$scheduleId')({
  component: SchedulePage,
})

function SchedulePage() {
  const { workspaceSlug, scheduleId } = Route.useParams()
  const navigate = useNavigate()
  const workspaces = useQuery(workspacesQueryOptions)
  const workspace = workspaces.data?.find((w) => w.slug === workspaceSlug)
  const query = useQuery(scheduleQueryOptions(scheduleId))
  const workspaceId = query.data?.workspaceId ?? ''
  const update = useUpdateSchedule(scheduleId, workspaceId)
  const remove = useDeleteSchedule(scheduleId, workspaceId)

  const crumbs = [
    <Link key="ws" to="/workspaces/$workspaceSlug" params={{ workspaceSlug }}>
      {workspace?.name ?? '…'}
    </Link>,
    <Link
      key="schedules"
      to="/workspaces/$workspaceSlug/schedules"
      params={{ workspaceSlug }}
    >
      Расписания
    </Link>,
  ]

  if (query.isPending || query.isError) {
    return (
      <>
        <PageCrumbs items={crumbs} />
        <PageContainer>
          {query.isError ? (
            <ErrorState
              title="Расписание не найдено."
              description="Возможно, его удалили или ссылка ведёт не туда."
            />
          ) : (
            <LoadingRows rows={3} />
          )}
        </PageContainer>
      </>
    )
  }

  const schedule = query.data

  return (
    <>
      <PageCrumbs items={[...crumbs, schedule.name]} />
      <PageContainer>
        <PageHeader
          title={schedule.name}
          description="Форма этого пространства покажет только свободное время расписания."
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Действия">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Удаление отделено от прочего и покрашено ролью: оно необратимо, а
                    отказать может сервер — у расписания есть будущие записи или на
                    него ссылается форма. Текст отказа приходит оттуда же. */}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    remove.mutate(undefined, {
                      onSuccess: () =>
                        void navigate({
                          to: '/workspaces/$workspaceSlug/schedules',
                          params: { workspaceSlug },
                        }),
                    })
                  }
                >
                  <Trash2 className="size-4" />
                  Удалить расписание
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />

        {remove.isError && (
          <div className="mt-4">
            <ErrorState title="Расписание не удалено" description={humanError(remove.error)} />
          </div>
        )}

        <div className="mt-8 flex flex-col gap-12">
          <ScheduleEditor
            schedule={schedule}
            saving={update.isPending}
            error={update.isError ? humanError(update.error) : undefined}
            onSave={(input) => update.mutate(input)}
          />
          <BlocksSection scheduleId={scheduleId} timezone={schedule.timezone} />
          <UpcomingSection scheduleId={scheduleId} timezone={schedule.timezone} />
        </div>
      </PageContainer>
    </>
  )
}
