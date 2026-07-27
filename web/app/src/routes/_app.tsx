import { createFileRoute, redirect, useNavigate, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { meQueryOptions, useLogout } from '../features/auth/queries'
import { useCreateForm } from '../features/forms/queries'
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
  const create = useCreateForm()
  // DOM-узел слота действий в шапке; страницы порталят в него свои кнопки.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)

  // Гард гарантирует наличие user; на всякий случай не рендерим оболочку без него.
  if (!user) return null

  function handleCreate() {
    create.mutate(undefined, {
      onSuccess: (form) => navigate({ to: '/forms/$slug/edit', params: { slug: form.slug } }),
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
        {/* Шапка зафиксирована (sticky): вся страница скроллится, а верхний бар
            остаётся на месте. z-20 — над контентом редактора, bg — чтобы контент
            не просвечивал под ней. */}
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          {/* Слот действий страницы (крошки, кнопки редактора и т.п.). */}
          <div ref={setHeaderSlot} className="flex flex-1 items-center gap-2" />
        </header>
        {/* Отступы задаёт каждая страница сама: редактору нужен bleed, дашборду/
            ответам — обычные поля. */}
        {/* data-scroll-root — метка настоящего контейнера прокрутки кабинета: окно тут
            не скроллится, скроллится этот <main>. Её ищет замок прокрутки полотна
            (builder/scrollLock.ts) — без метки он вешал бы overflow:hidden на body и
            молча ничего не делал. Переносишь прокрутку в другой узел — переноси метку. */}
        <main data-scroll-root className="flex-1 overflow-auto">
          {!user.emailVerified && <VerifyEmailBanner />}
          <HeaderSlotContext.Provider value={headerSlot}>
            <Outlet />
          </HeaderSlotContext.Provider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
