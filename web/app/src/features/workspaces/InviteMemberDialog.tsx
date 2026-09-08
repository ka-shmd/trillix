import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import { inviteErrorText } from './inviteError'
import { useInviteMember } from './queries'
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

// Приглашение — диалог по кнопке в заголовке раздела (решение владельца
// 2026-09-08, отменяет прежнее «раздел с полем почты в потоке»): позвать человека
// это «завести новое» в своём разделе, и правило DESIGN-SYSTEM §1 для него общее с
// «Новой формой» и «Новым расписанием».
export function InviteMemberDialog({
  workspaceId,
  seats,
  open,
  onOpenChange,
}: {
  workspaceId: string
  // seats — сколько мест занято и сколько их всего; `undefined` = потолка нет
  // (безлимит) либо снимок тарифа ещё не приехал. Считает вызывающий: право
  // спросить тариф есть не у всех, и знает об этом он.
  seats: { used: number; limit: number } | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const invite = useInviteMember(workspaceId)
  const [email, setEmail] = useState('')
  const trimmed = email.trim()
  const full = seats !== undefined && seats.used >= seats.limit

  // Ни набранное, ни отказ не переживают закрытие: следующее открытие должно
  // начинаться с чистого поля, а не с прошлой попытки.
  function close() {
    setEmail('')
    invite.reset()
    onOpenChange(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (trimmed === '') return
    invite.mutate(trimmed, {
      onSuccess: () => {
        // Успех уносит диалог и говорит тостом: приглашённый появится строкой в
        // разделе «Приглашены» за спиной диалога, и держать окно открытым, чтобы
        // сообщить об этом, значит прятать сам результат.
        toast.success(`Приглашение отправлено на ${trimmed}.`)
        close()
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Пригласить в пространство</DialogTitle>
          <DialogDescription>
            Ссылка придёт на почту и будет действовать неделю. Войдя по ней, человек станет
            редактором: сможет работать с формами, ответами и расписаниями, но не с тарифом и
            составом.
          </DialogDescription>
        </DialogHeader>

        {full ? (
          // Отказ ДО набора адреса, а не после отправки: исчерпанный лимит не
          // зависит от того, чью почту наберут, и говорить о нём после ввода
          // значит требовать работы впустую.
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Свободных мест не осталось: на текущем тарифе в пространство помещается{' '}
              {seats.limit}. Освободите место, сняв доступ, или перейдите на тариф побольше.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Закрыть
              </Button>
              <Button asChild>
                <Link to="/settings/plan">Посмотреть тарифы</Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="invite-email" className="mb-2 block">
                Адрес почты
              </Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="coworker@example.com"
                autoFocus
              />
              {seats !== undefined && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Занято {seats.used} из {seats.limit} мест.
                </p>
              )}
              {invite.isError && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {inviteErrorText(invite.error)}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Отмена
              </Button>
              <Button type="submit" disabled={trimmed === '' || invite.isPending}>
                {invite.isPending ? 'Отправляем…' : 'Пригласить'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
