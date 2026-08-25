import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { meQueryOptions } from '../features/auth/queries'
import { invitationQueryOptions, useAcceptInvitation } from '../features/workspaces/queries'
import { ApiError } from '../shared/api/errors'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Экран приглашения (/invite?token=…). ВНЕ группы _app намеренно: та за гардом
// сессии, а сюда приходят по ссылке из письма — аккаунта может ещё не быть, и
// человек должен увидеть, куда его зовут, до регистрации.
export const Route = createFileRoute('/invite')({
  validateSearch: z.object({ token: z.string().optional().catch(undefined) }),
  component: InvitePage,
})

function InvitePage() {
  const { token = '' } = Route.useSearch()
  const navigate = useNavigate()
  const invitation = useQuery({ ...invitationQueryOptions(token), enabled: token !== '' })
  // Сессия может отсутствовать — это законное состояние экрана, поэтому запрос
  // «кто я» здесь не гард, а вопрос: ошибка означает «не вошёл».
  const me = useQuery({ ...meQueryOptions, retry: false })
  const accept = useAcceptInvitation()

  if (token === '') return <Shell>Ссылка неполная: в ней нет токена приглашения.</Shell>
  if (invitation.isPending || me.isPending) {
    return (
      <Shell>
        <Skeleton className="h-6 w-64" />
      </Shell>
    )
  }
  if (invitation.isError) {
    return <Shell>Такого приглашения нет — возможно, ссылку отозвали.</Shell>
  }

  const inv = invitation.data
  if (inv.state === 'used') {
    return <Shell>По этой ссылке уже вошли. Попросите новую, если доступ нужен снова.</Shell>
  }
  if (inv.state === 'expired') {
    return <Shell>Срок действия ссылки истёк. Попросите прислать новую.</Shell>
  }

  const signedIn = me.data !== undefined

  return (
    <Shell>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">
        Вас приглашают в «{inv.workspaceName}»
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Приглашение выписано на {inv.email}. Роль — редактор: формы и ответы, без доступа к тарифу.
      </p>

      {signedIn ? (
        <>
          <Button
            disabled={accept.isPending}
            onClick={() =>
              accept.mutate(token, {
                // В адрес едет slug, а не id: так пространство названо во всех
                // URL кабинета (shared/currentWorkspace).
                onSuccess: (ws) => navigate({ to: '/forms', search: { w: ws.slug } }),
              })
            }
          >
            {accept.isPending ? 'Принимаем…' : 'Принять приглашение'}
          </Button>
          {accept.isError && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {acceptErrorText(accept.error, inv.email)}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mb-4 text-sm">
            Чтобы принять приглашение, войдите под {inv.email} или заведите аккаунт на этот адрес.
          </p>
          <div className="flex gap-2">
            <Button asChild>
              <Link to="/register">Зарегистрироваться</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/login">Войти</Link>
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            После входа вернитесь по ссылке из письма — она останется рабочей.
          </p>
        </>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-lg p-8">{children}</div>
}

function acceptErrorText(error: unknown, invitedEmail: string): string {
  if (!(error instanceof ApiError)) return 'Не удалось принять приглашение.'
  switch (error.code) {
    case 'forbidden':
      return `Приглашение выписано на ${invitedEmail} — войдите под этим адресом.`
    case 'link_expired':
      return 'Ссылка больше не годна: по ней уже вошли или истёк срок.'
    default:
      return 'Не удалось принять приглашение.'
  }
}
