import { Suspense, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  listedSchedule,
  scheduleQueryOptions,
  useDeleteSchedule,
  useUpdateSchedule,
} from '../../shared/schedules/queries'
import { preloadCalendar } from '../../shared/calendarChunk'
import { ScheduleEditor } from '../../features/schedules/ScheduleEditor'
import { SchedulePanel } from '../../features/schedules/SchedulePanel'
import { CancelBookingDialog } from '../../features/schedules/CancelBookingDialog'
import { LazyScheduleCanvas } from '../../features/schedules/lazyCanvas'
import { preloadScheduleCanvas } from '../../features/schedules/canvasChunk'
import { BookingDetails } from '../../features/schedules/BookingDetails'
import { SETTINGS_TITLE } from '../../features/schedules/settingNames'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { submissionQueryOptions } from '../../features/submissions/queries'
import { SubmissionPanel } from '../../features/submissions/SubmissionPanel'
import { answerColumns } from '../../features/submissions/columns'
import { formatAnswer } from '../../features/submissions/answerFormat'
import { listRow } from '../../features/submissions/rows'
import { type Booking } from '../../entities/schedule'
import { humanError } from '../../shared/api/errors'
import { PageCrumbs, PageActions } from '../../shared/page/headerPortals'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
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
//
// СТРАНИЦА ПОЯВЛЯЕТСЯ ОДНИМ КАДРОМ, БЕЗ СКЕЛЕТОВ (решение владельца 2026-09-14): полоса и
// полотно рисуются вместе, а записи и занятое время доезжают поверх готовой сетки.
// Скелеты по частям были не данными, а догрузкой библиотек (FullCalendar и
// react-day-picker живут за ленивыми границами), поэтому:
//
//  • чанки грузятся заранее — на списке расписаний и в loader этой страницы, который
//    роутер ждёт до перехода;
//  • документ расписания со списка берётся из его кэша (`listedSchedule`), и свежий
//    доезжает запросом поверх;
//  • на случай, когда чанк всё же не готов, половины ждут ОДНОЙ границей без заглушки.
export const Route = createFileRoute('/_app/w/$workspaceSlug/schedules/$scheduleId')({
  loader: async () => {
    await Promise.all([preloadScheduleCanvas(), preloadCalendar()])
  },
  component: SchedulePage,
})

function SchedulePage() {
  const { workspaceSlug, scheduleId } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const workspaces = useQuery(workspacesQueryOptions)
  const workspace = workspaces.data?.find((w) => w.slug === workspaceSlug)
  const query = useQuery({
    ...scheduleQueryOptions(scheduleId),
    initialData: () => listedSchedule(qc, scheduleId),
    // Данные списка считаются устаревшими сразу: они стоят на экране, пока едет
    // свежий документ, а не заменяют его.
    initialDataUpdatedAt: 0,
  })
  const workspaceId = query.data?.workspaceId ?? ''
  const update = useUpdateSchedule(scheduleId, workspaceId)
  const remove = useDeleteSchedule(scheduleId, workspaceId)
  const [settings, setSettings] = useState(false)
  // Даты, которые сейчас показывает полотно, и дата, к которой его просят перейти.
  // Две разные вещи: первая приезжает ОТ полотна (оно решает, что показать), вторая
  // уходит К нему по клику в мини-календаре.
  const [visible, setVisible] = useState<string[]>([])
  const [goToDate, setGoToDate] = useState<string | undefined>(undefined)
  // Запись, чья КАРТОЧКА открыта: имя формы, время и участники. Открывается кликом
  // по событию на полотне и строкой списка ближайших.
  const [card, setCard] = useState<Booking | null>(null)
  // Запись, чей ОТВЕТ открыт окном целиком. Второе окно, а не то же самое: карточка
  // отвечает «кто придёт», ответ — «что человек написал», и это разные вопросы.
  const [openBooking, setOpenBooking] = useState<Booking | null>(null)
  // Запись, отмену которой подтверждают. Диалог живёт ЗДЕСЬ, а не в полотне и не в
  // списке: спрашивают его обе половины экрана, и два экземпляра одного вопроса —
  // это два разных обещания на одно действие.
  const [cancelling, setCancelling] = useState<Booking | null>(null)

  const crumbs = [
    <Link key="ws" to="/w/$workspaceSlug/forms" params={{ workspaceSlug }}>
      {workspace?.name ?? '…'}
    </Link>,
    <Link key="schedules" to="/w/$workspaceSlug/schedules" params={{ workspaceSlug }}>
      Расписания
    </Link>,
  ]

  // Пока документа нет (прямой заход по ссылке), страница пуста, а не мигает скелетом:
  // следующим кадром она появляется целиком.
  if (query.isPending) return <PageCrumbs items={crumbs} />

  if (query.isError) {
    return (
      <>
        <PageCrumbs items={crumbs} />
        <div className="p-6">
          <ErrorState
            title="Расписание не найдено."
            description="Возможно, его удалили или ссылка ведёт не туда."
          />
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

      <Suspense fallback={null}>
      <div className="flex h-full min-h-0">
        {/* Полоса прячется на узком экране целиком: мини-календарь и список рядом с
            сеткой требуют ширины, которой там нет, а сетка на телефоне и так
            открывается видом дня. */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r p-3 xl:block">
          <SchedulePanel
            schedule={schedule}
            visible={visible}
            onPick={setGoToDate}
            onOpenSubmission={setOpenBooking}
            onCancelBooking={setCancelling}
          />
        </aside>

        <div className="min-w-0 flex-1">
          {/* onRange — СТАБИЛЬНАЯ функция (setState): полотно зовёт её эффектом, и
              стрелка, созданная тут же в разметке, устраивала бы цикл перерисовок. */}
          <LazyScheduleCanvas
            schedule={schedule}
            goToDate={goToDate}
            onRange={setVisible}
            onOpenBooking={setCard}
          />
        </div>
      </div>
      </Suspense>

      {/* ОКНО ОТВЕТА — ТОТ ЖЕ КОМПОНЕНТ, ЧТО НА СТРАНИЦЕ ОТВЕТОВ (решение владельца
          2026-09-04). Живёт на СТРАНИЦЕ, а не в полотне: компонент окна принадлежит
          фиче ответов, а импорт фичи из фичи запрещён (web/CLAUDE.md) — маршрут же
          складывает фичи по определению. */}
      {/* КАРТОЧКА ЗАПИСИ. Почта участника лежит в ОТВЕТЕ формы, а схема — в форме;
          обе фичи чужие полотну, поэтому данные собираются здесь, а рисует их
          компонент расписаний. */}
      <BookingCardDialog
        booking={card}
        timezone={schedule.timezone}
        onClose={() => setCard(null)}
        onCancel={(b) => {
          setCard(null)
          setCancelling(b)
        }}
      />

      <BookingSubmissionDialog booking={openBooking} onClose={() => setOpenBooking(null)} />

      {/* Диалог отмены — ОДИН НА ОБЕ ПОВЕРХНОСТИ: карточку записи на полотне и строку
          списка слева. Вопрос, перечень последствий и сама мутация обязаны быть одни. */}
      <CancelBookingDialog
        scheduleId={scheduleId}
        booking={cancelling}
        timezone={schedule.timezone}
        onClose={() => setCancelling(null)}
      />

      <Sheet open={settings} onOpenChange={setSettings}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{SETTINGS_TITLE}</SheetTitle>
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
                              to: '/w/$workspaceSlug/schedules',
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

// BookingCardDialog — карточка записи вместе с контактами участника.
//
// ПОЧТА ЖИВЁТ В ОТВЕТЕ ФОРМЫ, а не в строке брони (0050), поэтому её приходится
// поднимать двумя запросами: сам ответ и схему формы, из которой берутся подписи
// вопросов. Оба — только при открытом окне: пока автор смотрит на сетку, ходить за
// ними незачем.
//
// Показываются ответы на ВОПРОСЫ ТИПА «почта», а не «тот адрес, куда мы пишем».
// Выбор адреса для письма — правило сервера (`domain.BookingAddress`: сначала
// назначенный источник, потом первый годный email-вопрос), и повторять его здесь
// значило бы завести третье зеркало, которое ошибётся молча и покажет чужой адрес.
// Форма с одним вопросом про почту — а это подавляющее большинство — и так даёт
// ровно одну строку.
function BookingCardDialog({
  booking,
  timezone,
  onClose,
  onCancel,
}: {
  booking: Booking | null
  timezone: string
  onClose: () => void
  onCancel: (booking: Booking) => void
}) {
  const submissionId = booking?.submissionId ?? ''
  const form = useQuery({
    ...formDetailQueryOptions(booking?.formSlug ?? ''),
    enabled: booking !== null && submissionId !== '',
  })
  const one = useQuery({
    ...submissionQueryOptions(booking?.formId ?? '', submissionId),
    enabled: booking !== null && submissionId !== '',
  })

  const values = one.data?.submission.answers ?? {}
  const files = one.data?.files ?? {}
  const columns = answerColumns(form.data?.draftSchema.blocks ?? [])

  const people = columns
    .filter((c) => c.block.type === 'email')
    .map((c) => ({ label: c.label, value: values[c.block.id] }))
    .filter(
      (p): p is { label: string; value: string } => typeof p.value === 'string' && p.value !== '',
    )

  // Остальные ответы — В ПОРЯДКЕ ВОПРОСОВ ФОРМЫ и теми же подписями и значениями,
  // что в таблице ответов (`answerColumns`, `formatAnswer`): id опций, согласие и
  // время записи иначе показались бы сырыми. Почта исключена — она уже стоит выше
  // участниками, и один и тот же адрес дважды в маленьком окне читается как сбой.
  const answers = columns
    .filter((c) => c.block.type !== 'email')
    .map((c) => ({ label: c.label, value: formatAnswer(c.block, values[c.block.id], files) }))
    .filter((a) => a.value !== '')

  return (
    <BookingDetails
      booking={booking}
      timezone={timezone}
      people={people}
      answers={answers}
      loading={form.isPending || one.isPending}
      onCancel={onCancel}
      onClose={onClose}
    />
  )
}

// BookingSubmissionDialog — ответ, из которого пришла запись, целиком.
//
// Данных нужно двое: сам ответ (своей ручкой по id — на полотне нет страницы списка,
// из которой окно рисуется в разделе «Ответы») и схема формы, из которой берутся
// подписи вопросов. Обе спрашиваются только при открытом окне: пока автор смотрит на
// сетку, ходить за ними незачем.
function BookingSubmissionDialog({
  booking,
  onClose,
}: {
  booking: Booking | null
  onClose: () => void
}) {
  const submissionId = booking?.submissionId ?? ''
  const form = useQuery({
    ...formDetailQueryOptions(booking?.formSlug ?? ''),
    enabled: booking !== null,
  })
  const one = useQuery({
    ...submissionQueryOptions(booking?.formId ?? '', submissionId),
    enabled: booking !== null && submissionId !== '',
  })

  const ready = form.data && one.data
  return (
    <Dialog open={booking !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        {(form.isPending || one.isPending) && <LoadingRows rows={4} />}
        {(form.isError || one.isError) && (
          <ErrorState
            title="Не удалось открыть ответ."
            description={humanError(form.error ?? one.error)}
          />
        )}
        {ready && (
          <SubmissionPanel
            row={listRow(one.data.submission)}
            columns={answerColumns(form.data.draftSchema.blocks)}
            files={one.data.files}
            formId={form.data.id}
            // Удаление ответа с живой будущей записью сервер не даст (стоп-кран фазы
            // 27), но если ответ всё же удалён — окну больше нечего показывать.
            onDeleted={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
