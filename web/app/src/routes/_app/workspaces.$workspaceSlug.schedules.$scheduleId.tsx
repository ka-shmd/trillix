import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  scheduleQueryOptions,
  useDeleteSchedule,
  useUpdateSchedule,
} from '../../shared/schedules/queries'
import { ScheduleEditor } from '../../features/schedules/ScheduleEditor'
import { SchedulePanel } from '../../features/schedules/SchedulePanel'
import { LazyScheduleCanvas } from '../../features/schedules/lazyCanvas'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { humanError } from '../../shared/api/errors'
import { PageCrumbs, PageActions } from '../../shared/page/headerPortals'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

// Страница одного расписания — РАБОЧИЙ СТОЛ, а не колонка разделов: слева узкая
// полоса (мини-календарь и ближайшие записи), справа полотно во весь остаток
// (решение владельца 2026-09-04).
//
// Отсюда два отступления от обычной сборки экрана (DESIGN-SYSTEM), и оба намеренные:
//
//  • `PageHeader` не рисуется. Имя расписания и так стоит последней крошкой, а
//    заголовок в полстраницы съел бы высоту у сетки — единственного, ради чего сюда
//    приходят.
//  • Страница занимает всю высоту оболочки и НЕ прокручивается целиком: прокрутка
//    живёт внутри половин. Иначе полотно, у которого высота считается в пикселях,
//    росло бы вниз, унося панель управления за край экрана.
//
// Параметры записи и удаление расписания уехали в шторку: это настройки, к которым
// возвращаются редко, а место в баре принадлежит тому, чем пользуются каждый день.
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
  const [settings, setSettings] = useState(false)
  // Даты, которые сейчас показывает полотно, и дата, к которой его просят перейти.
  // Две разные вещи: первая приезжает ОТ полотна (оно решает, что показать), вторая
  // уходит К нему по клику в мини-календаре.
  const [visible, setVisible] = useState<string[]>([])
  const [goToDate, setGoToDate] = useState<string | undefined>(undefined)

  const crumbs = [
    <Link key="ws" to="/workspaces/$workspaceSlug" params={{ workspaceSlug }}>
      {workspace?.name ?? '…'}
    </Link>,
    <Link key="schedules" to="/workspaces/$workspaceSlug/schedules" params={{ workspaceSlug }}>
      Расписания
    </Link>,
  ]

  if (query.isPending || query.isError) {
    return (
      <>
        <PageCrumbs items={crumbs} />
        <div className="p-6">
          {query.isError ? (
            <ErrorState
              title="Расписание не найдено."
              description="Возможно, его удалили или ссылка ведёт не туда."
            />
          ) : (
            <LoadingRows rows={3} />
          )}
        </div>
      </>
    )
  }

  const schedule = query.data

  return (
    <>
      <PageCrumbs items={[...crumbs, schedule.name]} />
      <PageActions>
        <Button variant="outline" size="sm" onClick={() => setSettings(true)}>
          <Settings2 className="size-4" />
          Параметры
        </Button>
      </PageActions>

      <div className="flex h-full min-h-0">
        {/* Полоса прячется на узком экране целиком: мини-календарь и список рядом с
            сеткой требуют ширины, которой там нет, а сетка на телефоне и так
            открывается видом дня. */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r p-3 xl:block">
          <SchedulePanel schedule={schedule} visible={visible} onPick={setGoToDate} />
        </aside>

        <div className="min-w-0 flex-1">
          {/* onRange — СТАБИЛЬНАЯ функция (setState): полотно зовёт её эффектом, и
              стрелка, созданная тут же в разметке, устраивала бы цикл перерисовок. */}
          <LazyScheduleCanvas schedule={schedule} goToDate={goToDate} onRange={setVisible} />
        </div>
      </div>

      <Sheet open={settings} onOpenChange={setSettings}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Параметры записи</SheetTitle>
            <SheetDescription>
              Как режется сетка времени и сколько человек помещается в один приём. Часы приёма
              правятся на полотне.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-8 px-4 pb-6">
            <ScheduleEditor
              schedule={schedule}
              saving={update.isPending}
              error={update.isError ? humanError(update.error) : undefined}
              onSave={(input) => update.mutate(input)}
            />

            {/* УДАЛЕНИЕ ЖИВЁТ ЗДЕСЬ (решение владельца 2026-09-04), а не меню в баре:
                на рабочем столе бар занят тем, чем пользуются каждый день, а снос
                расписания — редкое и необратимое действие, за которым идут в
                настройки. Отделено чертой и покрашено ролью; спрашивается диалогом,
                потому что отменить его нечем. */}
            <div className="border-t pt-6">
              <p className="text-sm font-semibold">Удалить расписание</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Формы, которые на него ссылаются, перестанут принимать записи. Пока у расписания
                есть будущие записи, удалить его нельзя.
              </p>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="mt-3 text-destructive">
                    <Trash2 className="size-4" />
                    Удалить расписание
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Удалить расписание «{schedule.name}»?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Действие необратимо. Отказать может сервер — у расписания есть будущие записи
                      или на него ссылается форма; тогда он скажет, что именно мешает.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Оставить</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        remove.mutate(undefined, {
                          onSuccess: () =>
                            void navigate({
                              to: '/workspaces/$workspaceSlug/schedules',
                              params: { workspaceSlug },
                            }),
                          onError: (e) => toast.error(humanError(e)),
                        })
                      }
                    >
                      Удалить
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
