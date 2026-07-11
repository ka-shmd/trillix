import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { meQueryOptions } from '../features/auth/queries'

// Layout-группа авторизации (login/register). Уже залогиненного не пускаем на
// формы — сразу в приложение.
export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ context }) => {
    // null означает «нет живой сессии» (401) — это ожидаемо на страницах входа.
    const me = await context.queryClient.ensureQueryData(meQueryOptions).catch(() => null)
    if (me) throw redirect({ to: '/' })
  },
  component: AuthLayout,
})

function AuthLayout() {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <Outlet />
      </div>
    </main>
  )
}
