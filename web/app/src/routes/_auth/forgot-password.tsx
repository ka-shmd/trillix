import { useState, type FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useForgotPassword } from '../../features/auth/queries'
import { forgotPasswordSchema } from '../../features/auth/validation'
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

export const Route = createFileRoute('/_auth/forgot-password')({
  component: ForgotPasswordPage,
})

function describeError(error: unknown): string | undefined {
  if (error == null) return undefined
  if (!(error instanceof ApiError)) return 'Сеть недоступна. Попробуйте ещё раз.'
  if (error.code === 'rate_limited') return 'Слишком много запросов. Попробуйте позже.'
  return 'Что-то пошло не так. Попробуйте ещё раз.'
}

function ForgotPasswordPage() {
  const mutation = useForgotPassword()
  const [email, setEmail] = useState('')
  const [fieldError, setFieldError] = useState<string>()

  // Успех одинаков для любого адреса (существование аккаунта не раскрываем):
  // «если аккаунт есть — письмо отправлено».
  if (mutation.isSuccess) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Проверьте почту</CardTitle>
          <CardDescription>
            Если аккаунт с адресом {email} существует, мы отправили на него ссылку для сброса
            пароля. Ссылка действует 30 минут.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
            Вернуться ко входу
          </Link>
        </CardFooter>
      </Card>
    )
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const parsed = forgotPasswordSchema.safeParse({ email })
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message)
      return
    }
    setFieldError(undefined)
    mutation.mutate(parsed.data)
  }

  const serverError = describeError(mutation.error)

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Сброс пароля</CardTitle>
        <CardDescription>
          Введите email вашего аккаунта — пришлём ссылку для установки нового пароля.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          {serverError && (
            <p role="alert" className="text-sm text-destructive">
              {serverError}
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
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? 'email-error' : undefined}
            />
            {fieldError && (
              <p id="email-error" role="alert" className="text-sm text-destructive">
                {fieldError}
              </p>
            )}
          </div>
          <Button type="submit" disabled={mutation.isPending} className="w-full">
            {mutation.isPending ? 'Отправка…' : 'Отправить ссылку'}
          </Button>
        </form>
      </CardContent>
      <CardFooter>
        <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
          Вспомнили пароль? Войти
        </Link>
      </CardFooter>
    </Card>
  )
}
