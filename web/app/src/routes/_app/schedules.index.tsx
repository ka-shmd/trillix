import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Plus } from 'lucide-react'
import { z } from 'zod'

import { DEFAULT_SCHEDULE, MAX_SCHEDULE_NAME_LEN } from '../../entities/schedule'
import { schedulesQueryOptions, useCreateSchedule } from '../../features/schedules/queries'
import { weekSummary } from '../../features/schedules/weekly'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
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

// Расписания записи на время (/schedules) — список пространства.
//
// Пространство названо в адресе SLUG'ом (`?w=`, пусто = личное) — общее правило
// кабинета; в id его переводит useCurrentWorkspace. Пока перевод не сделан, запрос
// не включается: с пустым id он показал бы расписания ЛИЧНОГО пространства под
// адресом командного.
const searchSchema = z.object({ w: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/schedules/')({
  validateSearch: searchSchema,
  component: SchedulesPage,
})

function SchedulesPage() {
  const workspace = useCurrentWorkspace()
  const crumb = useWorkspaceCrumb()
  const schedules = useQuery({
    ...schedulesQueryOptions(workspace?.id ?? ''),
    enabled: workspace !== undefined,
  })
  const [creating, setCreating] = useState(false)

  return (
    <>
      <PageCrumbs items={[crumb, 'Расписания']} />
      <PageContainer>
        <PageHeader
          title="Расписания"
          description="Часы, в которые к вам можно записаться через форму."
          actions={
            <Button onClick={() => setCreating(true)} disabled={workspace === undefined}>
              <Plus className="size-4" />
              Новое расписание
            </Button>
          }
        />

        <div className="mt-8 flex flex-col gap-3">
          {schedules.isPending && <LoadingRows rows={2} />}
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
              description="Расписание — это один поток занятости: один мастер, один кабинет, одна группа. Заведите его, и в форме появится вопрос о времени."
              action={<Button onClick={() => setCreating(true)}>Новое расписание</Button>}
            />
          )}

          {schedules.data?.map((s) => (
            <Link
              key={s.id}
              to="/schedules/$scheduleId"
              params={{ scheduleId: s.id }}
              search={(prev) => prev}
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
  onOpenChange,
}: {
  open: boolean
  workspaceId: string
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
            to: '/schedules/$scheduleId',
            params: { scheduleId: s.id },
            search: (prev) => prev,
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
          {/* Имя называет ТОГО, КТО ПРИНИМАЕТ, и это не педантизм: разные расписания
              друг о друге не знают, поэтому человек, ведущий и рисование, и пение,
              обязан быть ОДНИМ расписанием. Правильное имя подскажет это само. */}
          <DialogDescription>
            Называйте по тому, кто принимает: «Мария — рисование». Появится второй мастер — заведёте
            ему своё расписание, и занятость не перепутается.
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
