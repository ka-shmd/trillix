import { createFileRoute, redirect, useNavigate, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { meQueryOptions, useLogout } from '../features/auth/queries'

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

  // Гард гарантирует наличие user; на всякий случай не рендерим шапку без него.
  if (!user) return null

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-brand">Trierra</span>
        <div className="app-header-right">
          <span className="app-user">{user.email}</span>
          <button
            type="button"
            onClick={() => logout.mutate(undefined, { onSuccess: () => navigate({ to: '/login' }) })}
            disabled={logout.isPending}
          >
            {logout.isPending ? 'Выходим…' : 'Выйти'}
          </button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
