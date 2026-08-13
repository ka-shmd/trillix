import type { FormEvent } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { useConfirmEmailChange } from '../features/auth/queries'
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

// Второй шаг смены адреса (фаза 23, слайс D). Верхнеуровневый маршрут, как и
// /verify-email: ссылку из письма открывают из почтового клиента, где сессии
// кабинета может не быть вовсе, а _app увёл бы такого человека на /login.
const confirmSearchSchema = z.object({
  token: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/confirm-email-change')({
  validateSearch: confirmSearchSchema,
  component: ConfirmEmailChangePage,
})

function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Сеть недоступна. Попробуйте ещё раз.'
  if (error.code === 'rate_limited') return 'Слишком много попыток. Попробуйте позже.'
  // Адрес мог занять кто-то другой за те сутки, что жила ссылка, — это единственный
  // отказ, у которого есть внятное человеческое объяснение и своё действие.
  if (error.code === 'email_taken') {
    return 'Этот адрес уже занят другим аккаунтом. Запросите смену на другой адрес.'
  }
  return 'Ссылка недействительна или устарела. Запросите смену адреса заново.'
}

function ConfirmEmailChangePage() {
  const { token } = Route.useSearch()
  const confirm = useConfirmEmailChange()

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

  if (confirm.isSuccess) {
    return frame(
      'Адрес изменён',
      <CardContent>
        <CardDescription>
          Готово: аккаунт переехал на этот адрес. Входить теперь нужно по нему.
        </CardDescription>
      </CardContent>,
    )
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    // Явной кнопкой, а не на монтировании: токен одноразовый, и потребить его
    // должно осознанное действие, а не эффект, который может сработать дважды.
    confirm.mutate({ token: token as string })
  }

  return frame(
    'Смена адреса',
    <CardContent>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <CardDescription>
          Нажмите кнопку, чтобы перенести аккаунт на этот адрес.
        </CardDescription>
        {confirm.isError && (
          <p role="alert" className="text-sm text-destructive">
            {describeError(confirm.error)}
          </p>
        )}
        <Button type="submit" disabled={confirm.isPending} className="w-full">
          {confirm.isPending ? 'Переносим…' : 'Подтвердить адрес'}
        </Button>
      </form>
    </CardContent>,
  )
}
