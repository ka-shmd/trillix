import { useState } from 'react'

import type { User } from '../../../entities/user'
import { ApiError } from '../../../shared/api/errors'
import { Section } from '../../../shared/page/Section'
import { useDeleteAccount, useSendActionCode } from '../queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Удаление аккаунта — единственное необратимое действие страницы, поэтому оно
// стоит последним и отделено линией: в ряду одинаковых разделов оно читалось
// как ещё одна настройка.
//
// ⚠ ПОСЛЕДСТВИЯ НАЗВАНЫ В ДИАЛОГЕ, А НЕ ПОД ЗАГОЛОВКОМ РАЗДЕЛА. Подписи разделов
// с этой страницы убраны целиком (решение владельца 2026-09-08), но «формы
// перестанут открываться» — не украшение заголовка, а то, ради чего человек
// передумывает. Место такому тексту там, где решают, а не там, где проходят мимо.
export function DeleteAccountSection({ user, onDeleted }: { user: User; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)

  return (
    <Section title="Удаление аккаунта" className="border-t pt-12">
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Удалить аккаунт
        </Button>
      </div>

      <DeleteAccountDialog user={user} open={open} onOpenChange={setOpen} onDeleted={onDeleted} />
    </Section>
  )
}

// ДИАЛОГ ДВУХСТРАНИЧНЫЙ: сначала пароль, потом код из письма (решение владельца
// 2026-09-08). Пароль и код — доказательства РАЗНОЙ природы: первое человек
// знает, второе получает в другом месте и в другой момент. Стоя рядом в одной
// форме, они читались набором полей, а кнопка «Прислать код» посреди неё
// предлагала прерваться и уйти в почту, не закончив.
//
// ⚠ «ДАЛЕЕ» — НЕ ПУСТОЙ ПЕРЕХОД: он отправляет код. Поэтому вторая страница
// начинается с уже отправленного письма, и отдельной кнопки «прислать» рядом с
// полем нет — есть «отправить ещё раз» на случай, когда письмо не дошло.
//
// Проверить пароль на первой странице НЕЛЬЗЯ: ручки «проверь пароль» у бэка нет,
// и заводить её ради шага мастера значило бы выставить наружу оракул подбора.
// Поэтому неверный пароль всплывает только на второй странице — и ответ там
// честно называет оба поля: сервер намеренно не различает, что не подошло.
function DeleteAccountDialog({
  user,
  open,
  onOpenChange,
  onDeleted,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const remove = useDeleteAccount()
  const sendCode = useSendActionCode()
  const [step, setStep] = useState<'identity' | 'code'>('identity')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')

  // Состав подтверждения зеркалит серверный: пароль — если он есть, код — если
  // включён фактор. У аккаунта через провайдера без фактора доказательством
  // служит сама сессия, и страница остаётся одна.
  const needsPassword = user.hasPassword
  const needsCode = user.twoFactorEnabled
  const passwordReady = !needsPassword || password !== ''

  function close() {
    setStep('identity')
    setPassword('')
    setCode('')
    remove.reset()
    sendCode.reset()
    onOpenChange(false)
  }

  function submitDelete() {
    remove.mutate({ currentPassword: password, code: code.trim() }, { onSuccess: onDeleted })
  }

  function submitIdentity(e: React.FormEvent) {
    e.preventDefault()
    if (!passwordReady) return
    // Кода не будет — эта страница и есть последняя, и кнопка на ней удаляет.
    if (!needsCode) {
      submitDelete()
      return
    }
    remove.reset()
    sendCode.mutate(undefined, { onSuccess: () => setStep('code') })
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault()
    if (code.trim() === '') return
    submitDelete()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        {step === 'identity' ? (
          <>
            <DialogHeader>
              {needsCode && <StepLabel current={1} />}
              <DialogTitle>Удалить аккаунт навсегда?</DialogTitle>
              <DialogDescription>
                Вход перестанет работать, а опубликованные формы — открываться и принимать ответы.
                Отменить это самостоятельно нельзя, и адрес {user.email} останется занятым: завести
                на него новый аккаунт не получится.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={submitIdentity} className="flex flex-col gap-4">
              {needsPassword && (
                <div>
                  <Label htmlFor="delete-password" className="mb-2 block">
                    Текущий пароль
                  </Label>
                  <Input
                    id="delete-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                  />
                </div>
              )}

              {sendCode.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {deleteErrorText(sendCode.error, 'Не удалось отправить код. Попробуйте ещё раз.')}
                </p>
              )}
              {/* Отказ удаления на ПЕРВОЙ странице бывает только у аккаунта без
                  фактора: там она же и последняя. */}
              {!needsCode && remove.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {deleteErrorText(remove.error, 'Не удалось удалить аккаунт. Попробуйте ещё раз.')}
                </p>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>
                  Отмена
                </Button>
                {needsCode ? (
                  <Button type="submit" disabled={!passwordReady || sendCode.isPending}>
                    {sendCode.isPending ? 'Отправляем код…' : 'Далее'}
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={!passwordReady || remove.isPending}
                  >
                    {remove.isPending ? 'Удаляем…' : 'Удалить аккаунт'}
                  </Button>
                )}
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <StepLabel current={2} />
              <DialogTitle>Подтвердите, что это вы</DialogTitle>
              <DialogDescription>
                Мы отправили код на {user.email} — письмо приходит в течение минуты.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={submitCode} className="flex flex-col gap-4">
              <div>
                <Label htmlFor="delete-code" className="mb-2 block">
                  Код из письма
                </Label>
                <Input
                  id="delete-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  autoFocus
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 -ml-2"
                  disabled={sendCode.isPending}
                  onClick={() => sendCode.mutate()}
                >
                  {sendCode.isPending ? 'Отправляем…' : 'Отправить ещё раз'}
                </Button>
              </div>

              {remove.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {deleteErrorText(remove.error, 'Не удалось удалить аккаунт. Попробуйте ещё раз.')}
                </p>
              )}

              <DialogFooter>
                {/* «Назад», а не «Отмена»: отказ сервера не говорит, что именно не
                    подошло — пароль или код, — и починить пароль можно только
                    вернувшись. */}
                <Button type="button" variant="ghost" onClick={() => setStep('identity')}>
                  Назад
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={code.trim() === '' || remove.isPending}
                >
                  {remove.isPending ? 'Удаляем…' : 'Удалить аккаунт'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Счётчик страниц показывается, только когда страниц действительно две: у
// аккаунта без второго фактора «шаг 1 из 1» сообщал бы о мастере, которого нет.
function StepLabel({ current }: { current: 1 | 2 }) {
  return <p className="text-sm text-muted-foreground">Шаг {current} из 2</p>
}

function deleteErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      // Ответ один на оба поля: сервер намеренно не различает «пароль не тот» и
      // «код не тот», и формулировка обязана это выдерживать.
      case 'invalid_credentials':
        return 'Пароль или код не подошли. Проверьте и попробуйте ещё раз.'
      case 'rate_limited':
        return 'Слишком много попыток. Подождите минуту и попробуйте снова.'
      // 409 здесь ровно один: человек — владелец командного пространства, в
      // котором остались люди. Имена пространств есть в списке пространств, и
      // тащить их сюда из текста ошибки незачем.
      case 'conflict':
        return 'Вы владелец командных пространств, в которых есть участники. Передайте владение или удалите эти пространства.'
    }
  }
  return fallback
}
