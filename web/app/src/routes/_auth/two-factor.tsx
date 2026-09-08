import type { FormEvent } from 'react'
import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'

import { useLoginTwoFactor, useResendLoginCode } from '../../features/auth/queries'
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

// Второй шаг входа (фаза 23, слайс F). Живёт в группе _auth: сессии здесь ещё
// НЕТ — есть только подписанная HttpOnly-cookie с пропуском, которую поставил
// первый шаг. Поэтому экран ничего не знает о том, кто входит, и знать не
// должен: имя аккаунта на странице ввода кода — подсказка перебирающему.
export const Route = createFileRoute('/_auth/two-factor')({
  component: TwoFactorPage,
})

function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Сеть недоступна. Попробуйте ещё раз.'
  switch (error.code) {
    case 'unauthorized':
      // Пропуск протух или его нет: первый шаг надо пройти заново.
      return 'Время на ввод кода истекло. Войдите заново.'
    case 'rate_limited':
      return 'Слишком много попыток. Подождите и попробуйте снова.'
    default:
      return 'Код не подошёл. Проверьте письмо или запросите новый код.'
  }
}

function TwoFactorPage() {
  const navigate = useNavigate()
  const login = useLoginTwoFactor()
  const resend = useResendLoginCode()
  const [code, setCode] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (code.trim() === '') return
    login.mutate({ code: code.trim() }, { onSuccess: () => navigate({ to: '/' }) })
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Код подтверждения</CardTitle>
        <CardDescription>
          Мы отправили код на почту вашего аккаунта — вход выполняется с устройства, которое мы
          ещё не видели. Письмо приходит в течение минуты.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="totp-code" className="mb-2 block">
              Код
            </Label>
            <Input
              id="totp-code"
              // inputMode числовой, но не type=number: последний ломает
              // ведущий ноль и рисует бесполезные стрелки счётчика.
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
          </div>
          {login.isError && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(login.error)}
            </p>
          )}
          <Button type="submit" disabled={code.trim() === '' || login.isPending}>
            {login.isPending ? 'Проверяем…' : 'Войти'}
          </Button>
          {/* Письмо теряется в спаме чаще, чем кажется, а другого способа
              получить код у человека нет. */}
          <Button
            type="button"
            variant="ghost"
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
          >
            {resend.isPending ? 'Отправляем…' : 'Отправить код ещё раз'}
          </Button>
          {resend.isSuccess && !resend.isPending && (
            <p className="text-sm text-muted-foreground">Новый код отправлен.</p>
          )}
          {resend.isError && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(resend.error)}
            </p>
          )}
        </form>
      </CardContent>
      <CardFooter>
        <Link to="/login" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Вернуться ко входу
        </Link>
      </CardFooter>
    </Card>
  )
}
