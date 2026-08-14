import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { CredentialsForm } from '../../features/auth/CredentialsForm'
import { useLinkProvider } from '../../features/auth/queries'
import { isTwoFactorRequired } from '../../features/auth/api'
import type { Credentials } from '../../features/auth/validation'
import { ApiError } from '../../shared/api/errors'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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

// Отказы второго шага. invalid_credentials здесь означает «код не подошёл», а не
// «пароль не тот»: пароль бэк принял шагом раньше.
function describeCodeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Сеть недоступна. Попробуйте ещё раз.'
  switch (error.code) {
    case 'unauthorized':
      return 'Привязка не начата или истекла. Вернитесь и войдите через провайдера заново.'
    case 'conflict':
      return 'Этот аккаунт провайдера уже привязан к другому пользователю.'
    case 'rate_limited':
      return 'Слишком много попыток. Подождите и попробуйте снова.'
    default:
      return 'Код не подошёл. Проверьте приложение или используйте резервный код.'
  }
}

// Второй шаг входа через провайдера: адрес уже занят аккаунтом с паролем.
// Сессию бэк на этом шаге не выдал сознательно — провайдеры не сообщают,
// подтверждён ли адрес, поэтому владение аккаунтом доказывается паролем
// (ADR §10). Какую именно личность привязывать, помнит подписанная cookie,
// выставленная колбэком, — фронт её не видит и подделать не может.
function LinkAccountPage() {
  const navigate = useNavigate()
  const mutation = useLinkProvider()
  const { provider } = Route.useSearch()

  // Пара, уже принятая бэком: у аккаунта включён второй фактор, и тот же запрос
  // нужно повторить с кодом. Держим её здесь, потому что привязки ещё нет —
  // бэк создаёт её только вместе с сессией, когда код сойдётся.
  const [awaitingCode, setAwaitingCode] = useState<Credentials | null>(null)

  const name = (provider && PROVIDER_NAMES[provider]) ?? 'провайдера'

  function submit(creds: Credentials, code?: string) {
    mutation.mutate(
      { ...creds, code },
      {
        onSuccess: (result) => {
          if (isTwoFactorRequired(result)) setAwaitingCode(creds)
          else navigate({ to: '/' })
        },
      },
    )
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Аккаунт уже существует</CardTitle>
        <CardDescription>
          {awaitingCode
            ? `Пароль верен. У аккаунта включён второй фактор — введите код из приложения, и мы привяжем вход через ${name}.`
            : `На этот адрес уже зарегистрирован аккаунт. Введите пароль от него — и мы привяжем вход через ${name}. В следующий раз хватит одного клика.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {awaitingCode ? (
          <TwoFactorStep
            pending={mutation.isPending}
            error={mutation.isError ? mutation.error : null}
            onSubmit={(code) => submit(awaitingCode, code)}
          />
        ) : (
          <CredentialsForm
            submitLabel="Привязать и войти"
            pending={mutation.isPending}
            serverError={mutation.error}
            onSubmit={(creds) => submit(creds)}
          />
        )}
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

// Второй шаг привязки — код. Отдельная форма, а не поле в CredentialsForm: та
// живёт ещё на входе и регистрации, где кода не бывает.
function TwoFactorStep({
  pending,
  error,
  onSubmit,
}: {
  pending: boolean
  error: unknown
  onSubmit: (code: string) => void
}) {
  const [code, setCode] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (code.trim() === '') return
    onSubmit(code.trim())
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="link-code">Код</Label>
        <Input
          id="link-code"
          // inputMode числовой, но не type=number: резервный код буквенный.
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
        />
      </div>
      {error != null && (
        <p role="alert" className="text-sm text-destructive">
          {describeCodeError(error)}
        </p>
      )}
      <Button type="submit" disabled={code.trim() === '' || pending} className="w-full">
        {pending ? 'Проверяем…' : 'Привязать и войти'}
      </Button>
    </form>
  )
}
