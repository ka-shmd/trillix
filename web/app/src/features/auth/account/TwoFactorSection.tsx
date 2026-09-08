import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { User } from '../../../entities/user'
import { ApiError } from '../../../shared/api/errors'
import { formatDate } from '../../../shared/format'
import { Section } from '../../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../../shared/page/states'
import {
  devicesQueryOptions,
  useDisableTwoFactor,
  useEnableTwoFactor,
  useForgetAllDevices,
  useForgetDevice,
} from '../queries'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { Switch } from '@/components/ui/switch'

// Второй фактор — код на почту при входе с незнакомого устройства
// (docs/design/two-factor-email.md). Раздел назван так же, как он назван в
// продукте и в письмах: «двухфакторная аутентификация» была единственным
// термином такого веса на весь кабинет.
//
// ТУМБЛЕР, А НЕ КНОПКА «Включить»/«Выключить»: настройка бинарная, и состояние
// должно читаться формой контрола, а не подписью действия рядом с ней. Тумблер
// СВОЕГО состояния не держит — он показывает серверное, а клик открывает диалог
// подтверждения; поэтому до успеха мутации он не двигается, и это верно: пароль
// может не подойти.
export function TwoFactorSection({ user }: { user: User }) {
  const [confirming, setConfirming] = useState(false)
  const on = user.twoFactorEnabled

  return (
    <Section title="Второй фактор">
      <div className="flex items-start justify-between gap-6 border-t py-4">
        <div className="min-w-0">
          <Label htmlFor="two-factor-switch" className="text-base font-semibold">
            Спрашивать код из письма при входе
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            {on
              ? 'Включён. На знакомых устройствах код не спрашивается — их список ниже.'
              : 'Выключен. Для входа достаточно пароля или провайдера.'}
          </p>
        </div>
        {/* Тумблер выровнен по первой строке подписи, а не по центру блока: у
            строки с длинным пояснением центр уезжает вниз. */}
        <Switch
          id="two-factor-switch"
          checked={on}
          className="mt-1"
          onCheckedChange={() => setConfirming(true)}
        />
      </div>

      <TwoFactorDialog user={user} open={confirming} onOpenChange={setConfirming} />
    </Section>
  )
}

function TwoFactorDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const enable = useEnableTwoFactor()
  const disable = useDisableTwoFactor()
  const [password, setPassword] = useState('')
  const on = user.twoFactorEnabled
  const pending = enable.isPending || disable.isPending
  // Пароль спрашиваем, только если он есть: у аккаунта через провайдера
  // доказательством служит сама сессия, как и везде в настройках.
  const ready = !user.hasPassword || password !== ''

  function close() {
    setPassword('')
    enable.reset()
    disable.reset()
    onOpenChange(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    const body = { currentPassword: password }
    const done = {
      onSuccess: () => {
        toast.success(on ? 'Второй фактор выключен.' : 'Второй фактор включён.')
        close()
      },
    }
    if (on) disable.mutate(body, done)
    else enable.mutate(body, done)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{on ? 'Выключить второй фактор?' : 'Включить второй фактор?'}</DialogTitle>
          <DialogDescription>
            {on
              ? 'Для входа снова будет достаточно пароля. Список знакомых устройств очистится.'
              : `При входе с незнакомого устройства после пароля мы попросим код из письма на ${user.email}. На этом компьютере код спрашивать не будем.`}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {user.hasPassword && (
            <div>
              <Label htmlFor="two-factor-password" className="mb-2 block">
                Текущий пароль
              </Label>
              <Input
                id="two-factor-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
          )}

          {(enable.isError || disable.isError) && (
            <p role="alert" className="text-sm text-destructive">
              {twoFactorErrorText(enable.error ?? disable.error)}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Отмена
            </Button>
            <Button type="submit" disabled={!ready || pending}>
              {pending ? 'Сохраняем…' : on ? 'Выключить' : 'Включить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Устройства, которым код больше не нужен. Раздел показывается только при
// включённом факторе: с выключенным строк нет и быть не может — бэк забывает их
// при выключении.
export function DevicesSection() {
  const devices = useQuery(devicesQueryOptions)
  const forget = useForgetDevice()
  const forgetAll = useForgetAllDevices()
  const [confirmingAll, setConfirmingAll] = useState(false)
  const list = devices.data ?? []

  return (
    <Section
      title="Знакомые устройства"
      action={
        list.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setConfirmingAll(true)}>
            Забыть все
          </Button>
        ) : undefined
      }
    >
      {devices.isPending && <LoadingRows rows={2} />}

      {devices.isError && (
        <ErrorState
          title="Не удалось загрузить список устройств."
          onRetry={() => void devices.refetch()}
        />
      )}

      {devices.data && list.length === 0 && (
        <EmptyState
          title="Знакомых устройств пока нет"
          description="Код спросят при первом входе с любого браузера."
        />
      )}

      {list.length > 0 && (
        <ul className="divide-y border-t">
          {list.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">
                  {d.label}
                  {d.current && (
                    <span className="text-sm font-normal text-muted-foreground">
                      {' '}
                      · это устройство
                    </span>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">
                  последний вход {formatDate(d.lastSeenAt)}
                </p>
              </div>
              {/* Обычная кнопка строки, как «Изменить имя», «Сменить» и «Забыть
                  все»: забывание устройства не деструктивно — оно ужесточает
                  вход, а не отнимает доступ. Приглушение в строке отведено под
                  деструктивное (DESIGN-SYSTEM §7), и «Забыть» им притворялось. */}
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() =>
                  forget.mutate(d.id, {
                    onError: () => toast.error('Не удалось забыть устройство.'),
                  })
                }
                disabled={forget.isPending}
              >
                Забыть
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* «Забыть все» рвёт все сеансы, кроме текущего, — последствие шире, чем
          обещает подпись кнопки, поэтому оно названо до нажатия, а не после. */}
      <AlertDialog open={confirmingAll} onOpenChange={setConfirmingAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Забыть все устройства?</AlertDialogTitle>
            <AlertDialogDescription>
              Все сеансы, кроме текущего, будут завершены: на других устройствах придётся войти
              заново, и при входе там спросят код.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                forgetAll.mutate(undefined, {
                  onSuccess: () => toast.success('Устройства забыты, остальные сеансы завершены.'),
                  onError: () => toast.error('Не удалось забыть устройства.'),
                })
              }
            >
              Забыть все
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

function twoFactorErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Пароль не подошёл. Проверьте и попробуйте ещё раз.'
      case 'conflict':
        return 'Второй фактор уже в этом состоянии. Обновите страницу.'
      case 'rate_limited':
        return 'Слишком много попыток. Подождите и попробуйте снова.'
    }
  }
  return 'Не получилось. Попробуйте ещё раз.'
}
