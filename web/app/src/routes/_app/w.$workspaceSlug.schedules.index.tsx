import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Plus } from 'lucide-react'

import { DEFAULT_SCHEDULE, MAX_SCHEDULE_NAME_LEN } from '../../entities/schedule'
import { schedulesQueryOptions, useCreateSchedule } from '../../shared/schedules/queries'
import { weekSummary } from '../../features/schedules/weekly'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { humanError } from '../../shared/api/errors'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Расписания записи на время — раздел ПРОСТРАНСТВА (/workspaces/{slug}/schedules).
//
// ⚠ ПРОСТРАНСТВО В ПУТИ, А НЕ В ПАРАМЕТРЕ `?w=`, и это не косметика. Пока экран стоял
// в верхнем ярусе сайдбара, ссылка на него параметра не несла, поэтому расписание,
// заведённое с командной страницы, молча уходило в ЛИЧНОЕ пространство — а форма
// команды потом не находила его в списке (отчёт владельца 2026-09-03). Адрес, который
// не может не назвать пространство, делает это состояние недостижимым; подписи и
// умолчания лечили бы симптом.
export const Route = createFileRoute('/_app/w/$workspaceSlug/schedules/')({
  component: SchedulesPage,
})

function SchedulesPage() {
  const { workspaceSlug } = Route.useParams()
  // Пространство резолвится ИЗ СПИСКА, как и везде в кабинете: он уже прочитан
  // сайдбаром, а запросы API ждут id (features/workspaces/current.ts).
  const workspaces = useQuery(workspacesQueryOptions)
  const workspace = workspaces.data?.find((w) => w.slug === workspaceSlug)
  const schedules = useQuery({
    ...schedulesQueryOptions(workspace?.id ?? ''),
    enabled: workspace !== undefined,
  })
  const [creating, setCreating] = useState(false)

  return (
    <>
      <PageCrumbs
        items={[
          <Link key="ws" to="/w/$workspaceSlug/forms" params={{ workspaceSlug }}>
            {workspace?.name ?? '…'}
          </Link>,
          'Расписания',
        ]}
      />
      <PageContainer>
        <PageHeader
          title="Расписания"
          description={
            workspace
              ? `Часы приёма пространства «${workspace.name}». Форма этого пространства сможет выбрать любое из них.`
              : 'Часы, в которые к вам можно записаться через форму.'
          }
          actions={
            <Button onClick={() => setCreating(true)} disabled={workspace === undefined}>
              <Plus className="size-4" />
              Новое расписание
            </Button>
          }
        />

        <div className="mt-8 flex flex-col gap-3">
          {(workspaces.isPending || schedules.isPending) && <LoadingRows rows={2} />}
          {workspaces.isError && (
            <ErrorState
              title="Не удалось загрузить пространство."
              onRetry={() => void workspaces.refetch()}
              retryLabel="Повторить"
            />
          )}
          {workspaces.data && !workspace && (
            <ErrorState
              title="Такого пространства нет или доступ к нему закрыт."
              description="Список пространств отдаёт только те, где вы состоите."
            />
          )}
          {schedules.isError && (
            <ErrorState
              title="Не удалось загрузить расписания."
              onRetry={() => void schedules.refetch()}
              retryLabel="Повторить"
            />
          )}

          {schedules.data?.length === 0 && (
            <EmptyState
              icon={CalendarClock}
              title="Расписаний пока нет"
              description="Расписание — это один поток занятости: один мастер, один кабинет, одна группа. Заведите его, и форма этого пространства сможет спрашивать время."
              action={<Button onClick={() => setCreating(true)}>Новое расписание</Button>}
            />
          )}

          {schedules.data?.map((s) => (
            <Link
              key={s.id}
              to="/w/$workspaceSlug/schedules/$scheduleId"
              params={{ workspaceSlug, scheduleId: s.id }}
              className="flex flex-col gap-1 rounded-lg border p-4 transition-colors hover:bg-accent/50"
            >
              <span className="text-base font-semibold">{s.name}</span>
              <span className="text-sm text-muted-foreground">
                {weekSummary(s.availability)} · приём {s.slotMinutes} мин
                {s.capacity > 1 && ` · мест ${s.capacity}`}
              </span>
            </Link>
          ))}
        </div>
      </PageContainer>

      {workspace && (
        <CreateDialog
          open={creating}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          workspaceSlug={workspaceSlug}
          onOpenChange={setCreating}
        />
      )}
    </>
  )
}

// Заведение спрашивает ТОЛЬКО ИМЯ: остальное приезжает умолчаниями, готовыми к
// работе (entities/schedule.ts), и правится на самой странице расписания. Диалог с
// восемью полями перед первой записью — это форма, которую нечем заполнить, пока не
// увидел, как она работает.
function CreateDialog({
  open,
  workspaceId,
  workspaceName,
  workspaceSlug,
  onOpenChange,
}: {
  open: boolean
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const navigate = useNavigate()
  const create = useCreateSchedule(workspaceId)

  function submit() {
    if (name.trim() === '') return
    create.mutate(
      { ...DEFAULT_SCHEDULE, name: name.trim() },
      {
        onSuccess: (s) => {
          onOpenChange(false)
          setName('')
          void navigate({
            to: '/w/$workspaceSlug/schedules/$scheduleId',
            params: { workspaceSlug, scheduleId: s.id },
          })
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новое расписание</DialogTitle>
          {/* Пространство названо ВСЛУХ, хотя оно и в адресе: расписание видно только
              формам своего пространства, и узнавать об этом опытным путём — потерянный
              вечер (отчёт владельца 2026-09-03).

              Имя расписания называет ТОГО, КТО ПРИНИМАЕТ, и это не педантизм: разные
              расписания друг о друге не знают, поэтому человек, ведущий и рисование, и
              пение, обязан быть ОДНИМ расписанием. */}
          <DialogDescription>
            Появится в пространстве «{workspaceName}» и будет доступно его формам. Называйте по
            тому, кто принимает: «Мария — рисование».
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-name">Название</Label>
          <Input
            id="schedule-name"
            autoFocus
            value={name}
            maxLength={MAX_SCHEDULE_NAME_LEN}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {humanError(create.error)}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={name.trim() === '' || create.isPending} onClick={submit}>
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
