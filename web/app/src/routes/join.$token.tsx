import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { meQueryOptions } from '../features/auth/queries'
import { joinPreviewQueryOptions, useAcceptJoinLink } from '../features/workspaces/queries'
import { ApiError } from '../shared/api/errors'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Экран ссылки-приглашения (/join/{token}). ВНЕ группы _app намеренно: та за
// гардом сессии, а сюда приходят по переданной ссылке — аккаунта может ещё не
// быть, и человек должен увидеть, куда его зовут, до регистрации.
//
// Токен стоит В ПУТИ, а не в параметре запроса: он и есть адрес приглашения, а
// потерянный параметр читался бы как «ссылка без токена» — состояние, которое
// пришлось бы объяснять человеку отдельным экраном.
export const Route = createFileRoute('/join/$token')({
  component: JoinPage,
})

function JoinPage() {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const preview = useQuery(joinPreviewQueryOptions(token))
  // Сессия может отсутствовать — это законное состояние экрана, поэтому запрос
  // «кто я» здесь не гард, а вопрос: ошибка означает «не вошёл».
  const me = useQuery({ ...meQueryOptions, retry: false })
  const accept = useAcceptJoinLink()

  if (preview.isPending || me.isPending) {
    return (
      <Shell>
        <Skeleton className="h-6 w-64" />
      </Shell>
    )
  }
  // Неизвестная, отозванная и истёкшая ссылки снаружи неразличимы намеренно
  // (WORKSPACES §4.1): действие у человека одно — попросить новую, а различение
  // позволяло бы перебором выяснять, какие токены существовали.
  if (preview.isError) {
    return (
      <Shell>
        Ссылка больше не работает: её отключили или вышел срок. Попросите прислать новую.
      </Shell>
    )
  }

  const signedIn = me.data !== undefined

  return (
    <Shell>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">
        Вас приглашают в «{preview.data.workspaceName}»
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Роль — редактор: формы, ответы и расписания пространства, без доступа к тарифу и составу.
      </p>

      {signedIn ? (
        <>
          <Button
            disabled={accept.isPending}
            onClick={() =>
              accept.mutate(token, {
                // В адрес едет slug, а не id: так пространство названо во всех
                // URL кабинета (shared/currentWorkspace).
                onSuccess: (ws) =>
                  navigate({ to: '/w/$workspaceSlug/forms', params: { workspaceSlug: ws.slug } }),
              })
            }
          >
            {accept.isPending ? 'Входим…' : 'Войти в пространство'}
          </Button>
          {accept.isError && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {acceptErrorText(accept.error)}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mb-4 text-sm">
            Чтобы войти в пространство, заведите аккаунт или войдите в существующий. Адрес почты
            любой — ссылка не выписана ни на кого конкретно.
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
            После входа вернитесь по этой же ссылке — она останется рабочей.
          </p>
        </>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-lg p-8">{children}</div>
}

function acceptErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось войти в пространство.'
  switch (error.code) {
    case 'link_expired':
      return 'Ссылка больше не годна: вышел срок. Попросите прислать новую.'
    case 'not_found':
      return 'Ссылка не работает: её отключили. Попросите прислать новую.'
    // Мест по тарифу владельца не осталось. Совет здесь чужой — платит не тот,
    // кто читает, — поэтому текст отправляет к владельцу, а не на страницу тарифа.
    case 'plan_required':
      return 'В пространстве не осталось свободных мест. Скажите об этом тому, кто вас позвал.'
    default:
      return 'Не удалось войти в пространство.'
  }
}
