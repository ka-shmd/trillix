import { createFileRoute, redirect, useNavigate, Outlet } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { meQueryOptions, useLogout } from '../features/auth/queries'
import { displayName } from '../entities/user'
import type { Workspace } from '../entities/workspace'
import { NEW_FORM_SLUG } from '../features/forms/draft'
import { formKeys } from '../features/forms/keys'
import { WorkspacesNav } from '../features/workspaces/WorkspacesNav'
import { useCurrentWorkspace } from '../features/workspaces/current'
import { useMemo, useState } from 'react'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { AppSidebar } from '../features/app-shell/AppSidebar'
import { VerifyEmailBanner } from '../features/app-shell/VerifyEmailBanner'
import { AppHeaderContext } from '../shared/appHeader'

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
  const currentWorkspace = useCurrentWorkspace()
  // DOM-узлы двух половин верхнего бара: слева путь, справа действия. Страницы
  // порталят в них через PageCrumbs/PageActions (shared/page/headerPortals.tsx).
  const [headerLeft, setHeaderLeft] = useState<HTMLElement | null>(null)
  const [headerRight, setHeaderRight] = useState<HTMLElement | null>(null)
  // Новый объект на каждый рендер оболочки перерисовывал бы каждую страницу с
  // крошками — контекст сравнивается по ссылке.
  const headerSlots = useMemo(
    () => ({ left: headerLeft, right: headerRight }),
    [headerLeft, headerRight],
  )

  // Гард гарантирует наличие user; на всякий случай не рендерим оболочку без него.
  if (!user) return null

  // «Новая форма» НИЧЕГО не создаёт: открывается редактор несуществующего черновика,
  // а форма заводится первой правкой (features/forms/draft.ts). Пространство едет в
  // адрес редактора — из него его прочтёт и создание (пусто = личное).
  //
  // Текущее пространство берётся из адреса ЦЕЛИКОМ (shared/currentWorkspace: `?w=`
  // либо путь `/workspaces/{slug}`), а не переносом прежнего search: на странице
  // пространства параметра `w` нет, и форма молча уезжала бы в личное.
  function handleCreate() {
    if (currentWorkspace) {
      handleCreateIn(currentWorkspace)
      return
    }
    // Список ещё не приехал — адрес остаётся как был: `?w=` из него редактор
    // прочтёт сам и переведёт уже в момент создания формы.
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
      search: workspace.isPersonal ? {} : { w: workspace.slug },
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
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background pr-2 pl-3">
          {/* Сворачивание сайдбара. На мобильном этот триггер — ЕДИНСТВЕННЫЙ способ
              его открыть: там сайдбар превращается в выезжающую шторку (Sheet),
              которая сама себя не показывает, и без кнопки навигации в кабинете с
              телефона нет вовсе. */}
          <SidebarTrigger className="text-muted-foreground" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          {/* Слева путь страницы, справа её действия. */}
          <div ref={setHeaderLeft} className="flex min-w-0 flex-1 items-center" />
          <div ref={setHeaderRight} className="flex shrink-0 items-center gap-2" />
        </header>
        {/* Отступы задаёт каждая страница сама: редактору нужен bleed, дашборду/
            ответам — обычные поля. */}
        <main className="flex-1 overflow-auto">
          {!user.emailVerified && <VerifyEmailBanner />}
          <AppHeaderContext.Provider value={headerSlots}>
            <Outlet />
          </AppHeaderContext.Provider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
