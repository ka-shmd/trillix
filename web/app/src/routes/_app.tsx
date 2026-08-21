import { createFileRoute, redirect, useNavigate, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { meQueryOptions, useLogout } from '../features/auth/queries'
import { displayName } from '../entities/user'
import { useCreateForm } from '../features/forms/queries'
import { useState } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '../features/app-shell/AppSidebar'
import { VerifyEmailBanner } from '../features/app-shell/VerifyEmailBanner'
import { HeaderSlotContext } from '../shared/headerSlot'
import { useCurrentWorkspaceId } from '../shared/currentWorkspace'

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
  const create = useCreateForm()
  // Форма создаётся в том пространстве, в котором человек сейчас работает,
  // а не всегда в личном: кнопка живёт в оболочке, поэтому пространство берётся
  // из адреса (пусто = личное).
  const workspaceId = useCurrentWorkspaceId()
  // DOM-узел слота действий в шапке; страницы порталят в него свои кнопки.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)

  // Гард гарантирует наличие user; на всякий случай не рендерим оболочку без него.
  if (!user) return null

  function handleCreate() {
    create.mutate({ workspaceId: workspaceId || undefined }, {
      onSuccess: (form) =>
        // search сохраняется: иначе редактор откроется «вне пространства», и
        // следующая созданная оттуда форма уедет в личное.
        navigate({ to: '/forms/$slug/edit', params: { slug: form.slug }, search: (prev) => prev }),
    })
  }

  return (
    <SidebarProvider>
      <AppSidebar
        userEmail={user.email}
        person={user}
        userName={displayName(user)}
        onCreateForm={handleCreate}
        creatingForm={create.isPending}
        onLogout={() => logout.mutate(undefined, { onSuccess: () => navigate({ to: '/login' }) })}
        loggingOut={logout.isPending}
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
