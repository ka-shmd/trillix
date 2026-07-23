import { useState } from 'react'
import { MailWarning } from 'lucide-react'
import { useResendVerification } from '../auth/queries'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

// Баннер «подтвердите email» (слайс C). Показывается в оболочке кабинета, пока
// email не подтверждён. Мягкое подтверждение: кабинет работает, баннер лишь
// напоминает. Кнопка шлёт письмо заново (ответ 204 одинаков — «уже подтверждён»
// сервис глотает), успех показываем текстом, не убирая баннер: подтверждение
// придёт переходом по ссылке из письма, а не этим запросом.
export function VerifyEmailBanner() {
  const resend = useResendVerification()
  const [sent, setSent] = useState(false)

  return (
    <Alert className="mx-4 mt-4 w-auto">
      <MailWarning />
      <AlertTitle>Подтвердите почту</AlertTitle>
      <AlertDescription>
        <p>
          Мы отправили ссылку подтверждения на ваш email при регистрации. Не пришло — отправим ещё
          раз.
        </p>
        {sent ? (
          <p className="text-foreground">Письмо отправлено — проверьте почту.</p>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={resend.isPending}
            onClick={() => resend.mutate(undefined, { onSuccess: () => setSent(true) })}
          >
            {resend.isPending ? 'Отправка…' : 'Отправить письмо ещё раз'}
          </Button>
        )}
        {resend.isError && (
          <p className="text-destructive">Не удалось отправить. Попробуйте позже.</p>
        )}
      </AlertDescription>
    </Alert>
  )
}
