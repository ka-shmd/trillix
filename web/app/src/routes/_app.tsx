import { createFileRoute, redirect, useNavigate, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { meQueryOptions, useLogout } from '../features/auth/queries'
import { useCreateForm } from '../features/forms/queries'
import { useState } from 'react'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from '../features/app-shell/AppSidebar'
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
  const create = useCreateForm()
  // DOM-узел слота действий в шапке; страницы порталят в него свои кнопки.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)

  // Гард гарантирует наличие user; на всякий случай не рендерим оболочку без него.
  if (!user) return null

  function handleCreate() {
    create.mutate(undefined, {
      onSuccess: (form) => navigate({ to: '/forms/$formId/edit', params: { formId: form.id } }),
    })
  }

  return (
    <SidebarProvider>
      <AppSidebar
        userEmail={user.email}
        onCreateForm={handleCreate}
        creatingForm={create.isPending}
        onLogout={() => logout.mutate(undefined, { onSuccess: () => navigate({ to: '/login' }) })}
        loggingOut={logout.isPending}
      />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          {/* Слот действий страницы (кнопки редактора и т.п.) — в одном баре с
              кнопкой сворачивания сайдбара. */}
          <div ref={setHeaderSlot} className="flex flex-1 items-center gap-2" />
        </header>
        {/* Отступы задаёт каждая страница сама: редактору нужен bleed, дашборду/
            ответам — обычные поля. */}
        <main className="flex-1 overflow-auto">
          <HeaderSlotContext.Provider value={headerSlot}>
            <Outlet />
          </HeaderSlotContext.Provider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
