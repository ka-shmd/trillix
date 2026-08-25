import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, House, SquarePlus } from 'lucide-react'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { CreateWorkspaceDialog } from '../../features/workspaces/CreateWorkspaceDialog'
import { WorkspaceSection } from '../../features/workspaces/WorkspaceSection'
import { WorkspaceFormList } from '../../features/forms/WorkspaceFormList'
import { NEW_FORM_SLUG } from '../../features/forms/draft'
import { formKeys } from '../../features/forms/keys'
import type { Workspace } from '../../entities/workspace'
import { useHeaderSlot } from '../../shared/headerSlot'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Обзор пространств (/workspaces): пространство — надпись с кружками участников,
// под ней его формы списком. Отдельного экрана участников нет — состав и
// приглашения живут в диалоге за кластером кружков.
export const Route = createFileRoute('/_app/workspaces/')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  const workspaces = useQuery(workspacesQueryOptions)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const headerSlot = useHeaderSlot()
  const [creating, setCreating] = useState(false)

  // «+» открывает редактор нового черновика ЭТОГО пространства; самой формы ещё нет —
  // её заводит первая правка (features/forms/draft.ts). Кнопка сайдбара «Новая форма»
  // так не умеет: она берёт пространство из ?w= адреса, которого на обзоре нет, — то
  // есть всегда клала бы форму в личное. Пространство едет в адрес редактора по общему
  // правилу кабинета (пусто = личное): из адреса его прочтёт и создание, и следующая
  // созданная оттуда форма.
  function createForm(workspace: Workspace) {
    void navigate({
      to: '/forms/$slug/edit',
      params: { slug: NEW_FORM_SLUG },
      search: workspace.isPersonal ? {} : { w: workspace.slug },
    })
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      {/* Название страницы и создание живут в верхней шапке — там же, где крошки
          редактора. Портал сохраняет React-контекст, несмотря на другое место в DOM. */}
      {headerSlot &&
        createPortal(
          <>
            <HeaderCrumbs />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-2"
              onClick={() => setCreating(true)}
            >
              {/* Квадрат с плюсом — «завести пространство»; голый Plus в шапке
                  кабинета уже занят смыслом «новая форма» (кнопка сайдбара). */}
              <SquarePlus className="size-4" />
              Новое пространство
            </Button>
          </>,
          headerSlot,
        )}
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
        <div className="space-y-4">
          {workspaces.data.map((ws) => (
            <WorkspaceSection
              key={ws.id}
              workspace={ws}
              onCreateForm={() => createForm(ws)}
              // Формы удалённого ушли вместе с ним; их страницы остались бы в
              // кэше и всплыли бы на дашборде по прямой ссылке ?w=<id>. Ключи
              // форм — чужая фича, поэтому чистка живёт здесь, а не в мутации.
              onDeleted={() => qc.invalidateQueries({ queryKey: formKeys.list() })}
            >
              <WorkspaceFormList workspaceId={ws.id} />
            </WorkspaceSection>
          ))}
        </div>
      )}

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
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
