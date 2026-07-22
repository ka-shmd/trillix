import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { CredentialsForm } from '../../features/auth/CredentialsForm'
import { useLinkProvider } from '../../features/auth/queries'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const PROVIDER_NAMES: Record<string, string> = {
  yandex: 'Яндекс',
}

const linkSearchSchema = z.object({
  provider: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_auth/link-account')({
  validateSearch: linkSearchSchema,
  component: LinkAccountPage,
})

// Второй шаг входа через провайдера: адрес уже занят аккаунтом с паролем.
// Сессию бэк на этом шаге не выдал сознательно — провайдеры не сообщают,
// подтверждён ли адрес, поэтому владение аккаунтом доказывается паролем
// (ADR §10). Какую именно личность привязывать, помнит подписанная cookie,
// выставленная колбэком, — фронт её не видит и подделать не может.
function LinkAccountPage() {
  const navigate = useNavigate()
  const mutation = useLinkProvider()
  const { provider } = Route.useSearch()

  const name = (provider && PROVIDER_NAMES[provider]) ?? 'провайдера'

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Аккаунт уже существует</CardTitle>
        <CardDescription>
          На этот адрес уже зарегистрирован аккаунт. Введите пароль от него — и мы привяжем вход
          через {name}. В следующий раз хватит одного клика.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CredentialsForm
          submitLabel="Привязать и войти"
          pending={mutation.isPending}
          serverError={mutation.error}
          onSubmit={(creds) => mutation.mutate(creds, { onSuccess: () => navigate({ to: '/' }) })}
        />
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          Забыли, каким способом входили?{' '}
          <Link to="/login" className="text-primary underline-offset-4 hover:underline">
            Обычный вход
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
