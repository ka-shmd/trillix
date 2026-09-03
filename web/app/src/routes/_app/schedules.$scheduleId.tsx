import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import { z } from 'zod'

import { scheduleQueryOptions, useDeleteSchedule, useUpdateSchedule } from '../../features/schedules/queries'
import { ScheduleEditor } from '../../features/schedules/ScheduleEditor'
import { BlocksSection } from '../../features/schedules/BlocksSection'
import { UpcomingSection } from '../../features/schedules/UpcomingSection'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
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
// Расписание адресуется ID, а не slug'ом: slug'ов у него нет — он публичной сущностью
// не является, наружу уезжает только свободное время формы.
const searchSchema = z.object({ w: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/schedules/$scheduleId')({
  validateSearch: searchSchema,
  component: SchedulePage,
})

function SchedulePage() {
  const { scheduleId } = Route.useParams()
  const navigate = useNavigate()
  const crumb = useWorkspaceCrumb()
  const query = useQuery(scheduleQueryOptions(scheduleId))
  const workspaceId = query.data?.workspaceId ?? ''
  const update = useUpdateSchedule(scheduleId, workspaceId)
  const remove = useDeleteSchedule(scheduleId, workspaceId)

  if (query.isPending || query.isError) {
    return (
      <>
        <PageCrumbs items={[crumb, 'Расписания']} />
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
      <PageCrumbs
        items={[
          crumb,
          <Link key="schedules" to="/schedules" search={(prev) => prev}>
            Расписания
          </Link>,
          schedule.name,
        ]}
      />
      <PageContainer>
        <PageHeader
          title={schedule.name}
          description="Форма покажет только свободное время этого расписания."
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
                      onSuccess: () => void navigate({ to: '/schedules', search: (prev) => prev }),
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
          <BlocksSection scheduleId={scheduleId} />
          <UpcomingSection scheduleId={scheduleId} timezone={schedule.timezone} />
        </div>
      </PageContainer>
    </>
  )
}
