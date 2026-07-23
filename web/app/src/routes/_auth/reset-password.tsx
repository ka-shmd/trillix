import { useState, type FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { useResetPassword } from '../../features/auth/queries'
import { resetPasswordSchema } from '../../features/auth/validation'
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

// Токен приезжает параметром адреса из письма. Мусор/отсутствие гасит catch —
// экран не должен падать от правки адреса руками, а показать «ссылка битая».
const resetSearchSchema = z.object({
  token: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_auth/reset-password')({
  validateSearch: resetSearchSchema,
  component: ResetPasswordPage,
})

function describeError(error: unknown): string | undefined {
  if (error == null) return undefined
  if (!(error instanceof ApiError)) return 'Сеть недоступна. Попробуйте ещё раз.'
  if (error.code === 'rate_limited') return 'Слишком много попыток. Попробуйте позже.'
  // Прошедший клиентскую проверку пароль → 422 почти всегда про токен: ссылка
  // истекла или уже использована. Точный текст бэка не показываем — он служебный.
  if (error.code === 'validation_failed')
    return 'Ссылка недействительна или устарела. Запросите сброс заново.'
  return 'Не удалось сбросить пароль. Попробуйте ещё раз.'
}

function ResetPasswordPage() {
  const { token } = Route.useSearch()
  const mutation = useResetPassword()
  const [password, setPassword] = useState('')
  const [fieldError, setFieldError] = useState<string>()

  // Нет токена в адресе — ссылка неполная/битая.
  if (!token) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Ссылка недействительна</CardTitle>
          <CardDescription>
            В ссылке нет кода сброса. Откройте её из письма целиком или запросите сброс заново.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Link
            to="/forgot-password"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Запросить сброс заново
          </Link>
        </CardFooter>
      </Card>
    )
  }

  // Пароль обновлён — все сессии разорваны, ведём на обычный вход.
  if (mutation.isSuccess) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Пароль обновлён</CardTitle>
          <CardDescription>
            Готово. Войдите с новым паролем — прежние сессии на всех устройствах завершены.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
            Перейти ко входу
          </Link>
        </CardFooter>
      </Card>
    )
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const parsed = resetPasswordSchema.safeParse({ password })
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message)
      return
    }
    setFieldError(undefined)
    mutation.mutate({ token: token as string, password: parsed.data.password })
  }

  const serverError = describeError(mutation.error)

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Новый пароль</CardTitle>
        <CardDescription>Задайте новый пароль для входа в аккаунт.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          {serverError && (
            <p role="alert" className="text-sm text-destructive">
              {serverError}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Новый пароль</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? 'password-error' : undefined}
            />
            {fieldError && (
              <p id="password-error" role="alert" className="text-sm text-destructive">
                {fieldError}
              </p>
            )}
          </div>
          <Button type="submit" disabled={mutation.isPending} className="w-full">
            {mutation.isPending ? 'Сохранение…' : 'Сохранить пароль'}
          </Button>
        </form>
      </CardContent>
      <CardFooter>
        <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
          Вернуться ко входу
        </Link>
      </CardFooter>
    </Card>
  )
}
