import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { CredentialsForm } from '../../features/auth/CredentialsForm'
import { ProviderButtons } from '../../features/auth/ProviderButtons'
import { useLogin } from '../../features/auth/queries'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// Причина неудачного входа через провайдера приезжает параметром адреса: колбэк
// бэка — навигация браузера, показать сообщение он может только так. Мусор в
// параметре гасит catch — экран входа не должен падать от правки адреса руками.
const loginSearchSchema = z.object({
  oauth: z
    .enum(['denied', 'expired', 'state', 'no_email', 'failed', 'provider_only'])
    .optional()
    .catch(undefined),
})

const OAUTH_MESSAGES: Record<string, string> = {
  denied: 'Вход через провайдера отменён.',
  expired: 'Вход занял слишком много времени. Попробуйте ещё раз.',
  state: 'Не удалось подтвердить запрос. Попробуйте войти заново.',
  no_email: 'Провайдер не передал адрес почты — он нужен для работы кабинета. Войдите по паролю.',
  failed: 'Провайдер сейчас недоступен. Попробуйте позже или войдите по паролю.',
  provider_only:
    'Аккаунт с этим адресом заведён через другой аккаунт провайдера, и пароля у него нет. Напишите в поддержку.',
}

export const Route = createFileRoute('/_auth/login')({
  validateSearch: loginSearchSchema,
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const mutation = useLogin()
  const { oauth } = Route.useSearch()

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Вход</CardTitle>
        <CardDescription>Войдите в свой аккаунт Trillix</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {oauth && (
          <p role="alert" className="text-sm text-destructive">
            {OAUTH_MESSAGES[oauth]}
          </p>
        )}
        <ProviderButtons />
        <CredentialsForm
          submitLabel="Войти"
          pending={mutation.isPending}
          serverError={mutation.error}
          onSubmit={(creds) => mutation.mutate(creds, { onSuccess: () => navigate({ to: '/' }) })}
        />
        <Link
          to="/forgot-password"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Забыли пароль?
        </Link>
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          Нет аккаунта?{' '}
          <Link to="/register" className="text-primary underline-offset-4 hover:underline">
            Регистрация
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
