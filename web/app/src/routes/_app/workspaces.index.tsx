import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, House, MoreHorizontal, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  membersQueryOptions,
  useCreateWorkspace,
  useDeleteWorkspace,
  useRenameWorkspace,
  workspacesQueryOptions,
} from '../../features/workspaces/queries'
import { MemberCluster } from '../../features/workspaces/MemberCluster'
import { MembersDialog } from '../../features/workspaces/MembersDialog'
import { FormRow } from '../../features/forms/FormRow'
import { formsListQueryOptions, useCreateForm } from '../../features/forms/queries'
import { formKeys } from '../../features/forms/keys'
import { DEFAULT_FORMS_SORT } from '../../entities/form'
import { MAX_WORKSPACE_NAME_LEN, type Workspace } from '../../entities/workspace'
import { ApiError } from '../../shared/api/errors'
import { useHeaderSlot } from '../../shared/headerSlot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

// Сколько форм видно под пространством сразу; «Показать ещё» просит следующую
// такую же страницу (решение владельца 2026-08-22). Страница показывает ВСЕ
// пространства разом, поэтому длина каждого списка — общий бюджет экрана, а не
// частное дело одного пространства.
const FORMS_PER_WORKSPACE = 10

// Обзор пространств (/workspaces): пространство — надпись с кружками участников,
// под ней его формы списком. Отдельного экрана участников нет — состав и
// приглашения живут в диалоге за кластером кружков.
export const Route = createFileRoute('/_app/workspaces/')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  const workspaces = useQuery(workspacesQueryOptions)
  const create = useCreateWorkspace()
  const [name, setName] = useState('')
  const headerSlot = useHeaderSlot()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') return
    create.mutate(trimmed, { onSuccess: () => setName('') })
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      {/* Название страницы живёт крошкой в верхней шапке — там же, где крошки
          редактора. Портал сохраняет React-контекст, несмотря на другое место в DOM. */}
      {headerSlot && createPortal(<HeaderCrumbs />, headerSlot)}
      {/* Заголовок остаётся в разметке, но не на экране: без него страница
          начиналась бы с h2 названий пространств, и структура документа
          рассыпалась бы. Видимое имя страницы — крошка выше. */}
      <h1 className="sr-only">Пространства</h1>

      {workspaces.isPending && (
        <div className="space-y-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {workspaces.isError && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Не удалось загрузить пространства.</p>
          <Button variant="outline" size="sm" onClick={() => workspaces.refetch()}>
            Повторить
          </Button>
        </div>
      )}

      {workspaces.data && (
        <div className="space-y-8">
          {workspaces.data.map((ws) => (
            <WorkspaceSection key={ws.id} workspace={ws} />
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-10 border-t pt-6">
        <Label htmlFor="workspace-name" className="mb-2 block">
          Новое пространство
        </Label>
        <div className="flex gap-2">
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, «Отдел маркетинга»"
            maxLength={MAX_WORKSPACE_NAME_LEN}
          />
          <Button type="submit" disabled={name.trim() === '' || create.isPending}>
            <Plus className="size-4" />
            {create.isPending ? 'Создаём…' : 'Создать'}
          </Button>
        </div>
        {create.isError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {/* Ветвимся по code, а не по тексту (web/CLAUDE.md): plan_required —
                не поломка, а упёрлись в тариф, и сказать это надо словами. */}
            {create.error instanceof ApiError && create.error.code === 'plan_required'
              ? 'На текущем тарифе больше пространств завести нельзя.'
              : 'Не удалось создать пространство. Попробуйте ещё раз.'}
          </p>
        )}
      </form>
    </div>
  )
}

// Крошки страницы: дом → «Пространства». Тот же вид, что у крошек редактора
// (BuilderScreen): один верхний бар — один способ назвать текущее место.
function HeaderCrumbs() {
  return (
    <nav aria-label="Хлебные крошки" className="flex min-w-0 items-center gap-1 text-sm">
      <Link
        to="/forms"
        search={(prev) => prev}
        aria-label="Дом"
        className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
      >
        <House className="size-4" />
      </Link>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
      <span className="min-w-0 truncate font-medium" aria-current="page">
        Пространства
      </span>
    </nav>
  )
}

// Одно пространство: заголовок с составом и его формы. Свой компонент, а не кусок
// разметки в цикле, — потому что у каждого пространства свой список форм со своей
// подгрузкой, а хук на пространство иначе не заведёшь.
function WorkspaceSection({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate()
  const create = useCreateForm()
  const rename = useRenameWorkspace(workspace.id)
  const remove = useDeleteWorkspace(workspace.id)
  const qc = useQueryClient()
  // Диалог состава принадлежит секции, а не кластеру кружков: открыть его могут
  // двое — кластер и меню «…», а два владельца одного состояния дали бы два окна.
  const [membersOpen, setMembersOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Права берутся из ответа состава — того же, что уже читает кластер кружков
  // (общий ключ кэша, лишнего запроса нет). Матрица прав живёт на сервере, и
  // кабинет не повторяет её на TypeScript: спрашиваем действие, а не роль.
  const members = useQuery(membersQueryOptions(workspace.id))
  const canManage = members.data?.permissions.includes('workspace.manage') ?? false
  const canDelete = members.data?.permissions.includes('workspace.delete') ?? false
  // Личное адресуем его настоящим id, а не пустой строкой: на этом экране
  // пространства равны, и разбирать «пусто = личное» здесь незачем — сервер
  // одинаково принимает workspaceId любого, где ты состоишь.
  const query = useInfiniteQuery(
    formsListQueryOptions({
      q: '',
      sort: DEFAULT_FORMS_SORT,
      workspaceId: workspace.id,
      limit: FORMS_PER_WORKSPACE,
    }),
  )
  const forms = query.data?.pages.flatMap((p) => p.forms) ?? []

  // «+» заводит форму СРАЗУ В ЭТОМ пространстве и уводит в редактор. Кнопка
  // сайдбара так не умеет: она живёт над деревом маршрутов и берёт пространство из
  // ?w= адреса, которого на обзоре нет, — то есть всегда клала бы форму в личное.
  // Пространство едет в адрес редактора по общему правилу кабинета (пусто =
  // личное): иначе следующая созданная оттуда форма уедет не туда.
  function handleCreateForm() {
    create.mutate(
      { workspaceId: workspace.id },
      {
        onSuccess: (form) =>
          navigate({
            to: '/forms/$slug/edit',
            params: { slug: form.slug },
            search: workspace.isPersonal ? {} : { w: workspace.id },
          }),
        // Тихо не получившаяся кнопка — худший исход: упереться можно в лимит форм
        // тарифа, и человек должен прочесть, во что именно упёрся.
        onError: (error) =>
          toast.error(
            error instanceof ApiError && error.code === 'plan_required'
              ? 'На текущем тарифе больше форм завести нельзя.'
              : 'Не удалось создать форму. Попробуйте ещё раз.',
          ),
      },
    )
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        {renaming ? (
          <RenameWorkspaceForm
            initial={workspace.name}
            pending={rename.isPending}
            onCancel={() => setRenaming(false)}
            onSubmit={(name) => rename.mutate(name, { onSuccess: () => setRenaming(false) })}
          />
        ) : (
          <>
            <h2 className="min-w-0 truncate text-lg font-bold tracking-tight">{workspace.name}</h2>
            {/* Число форм — с сервера (formCount), а не длина загруженного списка:
                под пространством видна первая десятка, и счёт по ней врал бы. */}
            <span className="shrink-0 text-sm text-muted-foreground">{workspace.formCount}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 shrink-0">
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">Действия с пространством «{workspace.name}»</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {canManage && (
                  <DropdownMenuItem onClick={() => setRenaming(true)}>
                    <Pencil className="size-4" />
                    Переименовать
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setMembersOpen(true)}>
                  <Users className="size-4" />
                  Участники
                </DropdownMenuItem>
                {/* Личное не удаляется: человеку негде было бы жить, а его формы
                    и подписка остались бы без места. Сервер отвергает это и сам
                    (422) — здесь просто нет пункта, который заведомо откажет. */}
                {canDelete && !workspace.isPersonal && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                      <Trash2 className="size-4" />
                      Удалить
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <MemberCluster workspace={workspace} onOpen={() => setMembersOpen(true)} />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={handleCreateForm}
            disabled={create.isPending}
          >
            <Plus className="size-4" />
            <span className="sr-only">Новая форма в пространстве «{workspace.name}»</span>
          </Button>
        </div>
      </div>

      <MembersDialog workspace={workspace} open={membersOpen} onOpenChange={setMembersOpen} />

      <DeleteWorkspaceDialog
        workspace={workspace}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              // Формы удалённого ушли вместе с ним; их страницы остались бы в
              // кэше и всплыли бы на дашборде по прямой ссылке ?w=<id>. Ключи
              // форм — чужая фича, поэтому чистка живёт здесь, а не в мутации.
              qc.invalidateQueries({ queryKey: formKeys.list() })
              setConfirmDelete(false)
            },
            onError: () => toast.error('Не удалось удалить пространство. Попробуйте ещё раз.'),
          })
        }
      />

      {query.isPending ? (
        <div className="space-y-1 py-1" aria-hidden="true">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : query.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="mb-3 text-sm">{formsErrorText(query.error)}</p>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Повторить
          </Button>
        </div>
      ) : forms.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">Пока нет форм.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {forms.map((form) => (
              <FormRow key={form.id} form={form} />
            ))}
          </ul>
          {query.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-1 mt-1 text-muted-foreground"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

// Замороженное даунгрейдом пространство отдаёт 403 на свои формы. Это не поломка:
// формы целы, доступ вернётся вместе с тарифом — и сказать это надо словами,
// а не «не удалось загрузить».
function formsErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'workspace_frozen') {
    return 'Доступ к формам закрыт: тариф больше не покрывает столько пространств или участников. Формы и ответы целы — доступ вернётся вместе с тарифом.'
  }
  return 'Не удалось загрузить формы пространства.'
}

// Инлайн-переименование пространства прямо в строке заголовка: отдельный экран
// ради одного поля не нужен. Пустое имя не отправляем — совпадает с серверной
// валидацией (имя обязательно, потолок MAX_WORKSPACE_NAME_LEN рун).
function RenameWorkspaceForm({
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: string
  pending: boolean
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const trimmed = name.trim()

  return (
    <form
      className="flex flex-1 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed !== '') onSubmit(trimmed)
      }}
    >
      <Label htmlFor="rename-workspace" className="sr-only">
        Название пространства
      </Label>
      <Input
        id="rename-workspace"
        value={name}
        onChange={(e) => setName(e.target.value)}
        // Escape отменяет правку не выходя из поля: тот же жест, что у полотна.
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
        autoFocus
        maxLength={MAX_WORKSPACE_NAME_LEN}
        className="h-8 max-w-xs"
      />
      <Button type="submit" size="sm" disabled={pending || trimmed === ''}>
        {pending ? 'Сохраняем…' : 'Сохранить'}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
        Отмена
      </Button>
    </form>
  )
}

// Подтверждение сноса пространства. Удаление необратимо и уносит чужой труд —
// формы и ответы всех участников, — поэтому кнопка оживает только после того,
// как название набрано руками: «Удалить/Отмена» здесь слишком дёшево стоит.
function DeleteWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  workspace: Workspace
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const confirmed = typed.trim() === workspace.name

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Набранное не переживает закрытие: иначе повторное открытие встречало
        // бы уже готовым к нажатию то, что должно спрашиваться заново.
        if (!next) setTyped('')
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить пространство «{workspace.name}»?</AlertDialogTitle>
          <AlertDialogDescription>
            Вместе с ним безвозвратно удалятся все его формы ({workspace.formCount}), ответы
            респондентов и загруженные к ним файлы. Участники потеряют доступ. Отменить это
            нельзя. Введите название пространства, чтобы подтвердить.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Label htmlFor="confirm-delete-workspace" className="sr-only">
          Название пространства
        </Label>
        <Input
          id="confirm-delete-workspace"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={workspace.name}
          autoComplete="off"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={!confirmed || pending}
            onClick={(e) => {
              // Radix закрывает окно по клику на действие; здесь оно должно
              // дожить до ответа сервера — иначе отказ некому будет показать.
              e.preventDefault()
              onConfirm()
            }}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {pending ? 'Удаляем…' : 'Удалить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
