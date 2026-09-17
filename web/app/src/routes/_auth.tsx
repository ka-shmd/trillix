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
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-muted/40 p-6">
      <Outlet />
      {/* Политика — там, где собираются данные (ч. 2 ст. 18.1 152-ФЗ): регистрация и вход
          через провайдера заводят аккаунт с любого из этих экранов. В новой вкладке, чтобы
          не терять набранное. */}
      <p className="text-xs text-muted-foreground">
        <a href="/legal/privacy" target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
          Политика обработки персональных данных
        </a>
        {' · '}
        <a href="/legal" target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
          Правовая информация
        </a>
      </p>
    </main>
  )
}
