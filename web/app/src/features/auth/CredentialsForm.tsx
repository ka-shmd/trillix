import { useState, type FormEvent } from 'react'
import { credentialsSchema, type Credentials } from './validation'
import { ApiError } from '../../shared/api/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type FieldErrors = Partial<Record<'email' | 'password', string>>

interface Props {
  submitLabel: string
  pending: boolean
  serverError: unknown
  onSubmit: (creds: Credentials) => void
}

// describeError переводит отказ бэка в человеческое сообщение: часть ошибок
// садится под конкретное поле, часть — общей строкой над формой.
function describeError(error: unknown): { formError?: string; fieldErrors: FieldErrors } {
  if (error == null) return { fieldErrors: {} }
  if (!(error instanceof ApiError)) {
    return { formError: 'Сеть недоступна. Попробуйте ещё раз.', fieldErrors: {} }
  }
  switch (error.code) {
    case 'invalid_credentials':
      return { formError: 'Неверный email или пароль', fieldErrors: {} }
    case 'email_taken':
      return { fieldErrors: { email: 'Этот email уже занят' } }
    case 'validation_failed':
      if (error.fields) return { fieldErrors: error.fields }
      return { formError: error.message, fieldErrors: {} }
    // Ниже — экран привязки провайдера: cookie с подтверждённой личностью живёт
    // 15 минут, и её протухание нужно объяснить, а не показать «unauthorized».
    case 'unauthorized':
      return {
        formError: 'Привязка не начата или истекла. Вернитесь и войдите через провайдера заново.',
        fieldErrors: {},
      }
    case 'conflict':
      return { formError: 'Этот аккаунт провайдера уже привязан к другому пользователю.', fieldErrors: {} }
    default:
      return { formError: error.message, fieldErrors: {} }
  }
}

export function CredentialsForm({ submitLabel, pending, serverError, onSubmit }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [clientErrors, setClientErrors] = useState<FieldErrors>({})

  const server = describeError(serverError)
  const fieldErrors: FieldErrors = { ...server.fieldErrors, ...clientErrors }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const parsed = credentialsSchema.safeParse({ email, password })
    if (!parsed.success) {
      const errs: FieldErrors = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]
        if (key === 'email' || key === 'password') errs[key] = issue.message
      }
      setClientErrors(errs)
      return
    }
    setClientErrors({})
    onSubmit(parsed.data)
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {server.formError && (
        <p role="alert" className="text-sm text-destructive">
          {server.formError}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? 'email-error' : undefined}
        />
        {fieldErrors.email && (
          <p id="email-error" role="alert" className="text-sm text-destructive">
            {fieldErrors.email}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Пароль</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={fieldErrors.password ? true : undefined}
          aria-describedby={fieldErrors.password ? 'password-error' : undefined}
        />
        {fieldErrors.password && (
          <p id="password-error" role="alert" className="text-sm text-destructive">
            {fieldErrors.password}
          </p>
        )}
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Отправка…' : submitLabel}
      </Button>
    </form>
  )
}
