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
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Outlet />
    </main>
  )
}
