import type { FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { useVerifyEmail } from '../features/auth/queries'
import { ApiError } from '../shared/api/errors'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'

// Верхнеуровневый маршрут (вне _auth/_app): ссылку из письма открывают и
// залогиненные, и нет. _auth увёл бы залогиненного на /, _app — незалогиненного
// на /login; здесь гарда нет, экран сам говорит исход.
//
// Токен приезжает параметром адреса. Мусор/отсутствие гасит catch — экран не
// должен падать от правки адреса руками, показываем «ссылка недействительна».
const verifySearchSchema = z.object({
  token: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/verify-email')({
  validateSearch: verifySearchSchema,
  component: VerifyEmailPage,
})

function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Сеть недоступна. Попробуйте ещё раз.'
  if (error.code === 'rate_limited') return 'Слишком много попыток. Попробуйте позже.'
  // Прошедший до бэка токен → 422 почти всегда «ссылка истекла или уже
  // использована». Точный текст бэка служебный, не показываем.
  return 'Ссылка недействительна или устарела. Войдите и запросите письмо заново.'
}

function VerifyEmailPage() {
  const { token } = Route.useSearch()
  const verify = useVerifyEmail()

  // Общая центрированная карточка: маршрут вне layout-групп, оболочку несёт сам.
  const frame = (title: string, body: React.ReactNode) => (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        {body}
        <CardFooter>
          <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
            Перейти в кабинет
          </Link>
        </CardFooter>
      </Card>
    </main>
  )

  // Нет токена в адресе — ссылка неполная/битая.
  if (!token) {
    return frame(
      'Ссылка недействительна',
      <CardContent>
        <CardDescription>
          В ссылке нет кода подтверждения. Откройте её из письма целиком.
        </CardDescription>
      </CardContent>,
    )
  }

  if (verify.isSuccess) {
    return frame(
      'Почта подтверждена',
      <CardContent>
        <CardDescription>
          Спасибо! Ваш адрес подтверждён — баннер в кабинете больше не появится.
        </CardDescription>
      </CardContent>,
    )
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    // Подтверждаем по явной кнопке, а не автоматически на монтировании: так токен
    // потребляется одним осознанным действием, без гонки эффекта со StrictMode/HMR.
    verify.mutate({ token: token as string })
  }

  return frame(
    'Подтверждение почты',
    <CardContent>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <CardDescription>
          Нажмите кнопку, чтобы подтвердить, что этот адрес ваш.
        </CardDescription>
        {verify.isError && (
          <p role="alert" className="text-sm text-destructive">
            {describeError(verify.error)}
          </p>
        )}
        <Button type="submit" disabled={verify.isPending} className="w-full">
          {verify.isPending ? 'Подтверждаем…' : 'Подтвердить почту'}
        </Button>
      </form>
    </CardContent>,
  )
}
