import { createFileRoute, redirect, useNavigate, Outlet } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { meQueryOptions, useLogout } from '../features/auth/queries'
import { displayName } from '../entities/user'
import type { Workspace } from '../entities/workspace'
import { NEW_FORM_SLUG } from '../features/forms/draft'
import { formKeys } from '../features/forms/keys'
import { WorkspacesNav } from '../features/workspaces/WorkspacesNav'
import { workspacesQueryOptions } from '../features/workspaces/queries'
import { useCurrentWorkspaceId } from '../shared/currentWorkspace'
import { useState } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '../features/app-shell/AppSidebar'
import { VerifyEmailBanner } from '../features/app-shell/VerifyEmailBanner'
import { HeaderSlotContext } from '../shared/headerSlot'

// Layout-группа приложения за сессией. Гард префетчит /auth/me; нет живой
// сессии → редирект на /login (защищённый маршрут не показывает контент).
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const navigate = useNavigate()
  const { data: user } = useQuery(meQueryOptions)
  const logout = useLogout()
  const qc = useQueryClient()
  const workspaces = useQuery(workspacesQueryOptions)
  const currentWorkspaceId = useCurrentWorkspaceId()
  // DOM-узел слота действий в шапке; страницы порталят в него свои кнопки.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)

  // Гард гарантирует наличие user; на всякий случай не рендерим оболочку без него.
  if (!user) return null

  // «Новая форма» НИЧЕГО не создаёт: открывается редактор несуществующего черновика,
  // а форма заводится первой правкой (features/forms/draft.ts). Пространство едет в
  // адрес редактора — из него его прочтёт и создание (пусто = личное).
  //
  // Текущее пространство берётся из адреса ЦЕЛИКОМ (shared/currentWorkspace: `?w=`
  // либо путь `/workspaces/{id}`), а не переносом прежнего search: на странице
  // пространства параметра `w` нет, и форма молча уезжала бы в личное.
  function handleCreate() {
    const current = workspaces.data?.find((w) => w.id === currentWorkspaceId)
    if (current) {
      handleCreateIn(current)
      return
    }
    // Списка ещё нет либо пространство не наше — адрес остаётся как был: `?w=`
    // из него редактор прочтёт сам, а чужой id всё равно отвергнет сервер.
    void navigate({
      to: '/forms/$slug/edit',
      params: { slug: NEW_FORM_SLUG },
      search: (prev) => prev,
    })
  }

  // «+» у пространства в сайдбаре: тот же ленивый черновик, но в НАЗВАННОМ
  // пространстве, а не в текущем — оно уезжает в адрес редактора (пусто = личное).
  function handleCreateIn(workspace: Workspace) {
    void navigate({
      to: '/forms/$slug/edit',
      params: { slug: NEW_FORM_SLUG },
      search: workspace.isPersonal ? {} : { w: workspace.id },
    })
  }

  return (
    <SidebarProvider>
      <AppSidebar
        userEmail={user.email}
        person={user}
        userName={displayName(user)}
        onCreateForm={handleCreate}
        onLogout={() => logout.mutate(undefined, { onSuccess: () => navigate({ to: '/login' }) })}
        loggingOut={logout.isPending}
        workspacesNav={
          <WorkspacesNav
            onCreateForm={handleCreateIn}
            // Формы снесённого пространства ушли вместе с ним; их страницы
            // остались бы в кэше и всплыли бы по прямой ссылке ?w=<id>. Ключи
            // форм — чужая фича, поэтому чистка живёт здесь, а не в мутации.
            onWorkspaceDeleted={() => qc.invalidateQueries({ queryKey: formKeys.list() })}
          />
        }
      />
      {/* ОБОЛОЧКА СЪЕЗЖАЕТ ВМЕСТЕ С ВЫЕЗЖАЮЩЕЙ ШТОРКОЙ. Ширину открытой шторки
          кладёт в --app-drawer тот, кто её открыл (DesignDrawer); закрытая — 0px.
          Отступ здесь, а не на <main>: шапка sticky и лежит ВНУТРИ этой коробки,
          поэтому съезжает вместе с содержимым — иначе шторка накрывала бы её край,
          а полотно уезжало бы под панель. Заодно колонка формы сама
          перецентрируется в оставшейся ширине (mx-auto у полотна).
          Переменная на корне, а не проп через три слоя: шторку открывают глубоко в
          фиче, а съезжает оболочка маршрута — тот же приём, которым рендерер
          надевает тему на документ. */}
      <SidebarInset className="pr-(--app-drawer) transition-[padding-right] duration-300 ease-in-out">
        {/* Шапка зафиксирована (sticky): вся страница скроллится, а верхний бар
            остаётся на месте. z-20 — над контентом редактора, bg — чтобы контент
            не просвечивал под ней. */}
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          {/* Слот действий страницы (крошки, кнопки редактора и т.п.). */}
          <div ref={setHeaderSlot} className="flex flex-1 items-center gap-2" />
        </header>
        {/* Отступы задаёт каждая страница сама: редактору нужен bleed, дашборду/
            ответам — обычные поля. */}
        <main className="flex-1 overflow-auto">
          {!user.emailVerified && <VerifyEmailBanner />}
          <HeaderSlotContext.Provider value={headerSlot}>
            <Outlet />
          </HeaderSlotContext.Provider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
