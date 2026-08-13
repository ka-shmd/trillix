import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { meQueryOptions, useUpdateProfile } from '../../features/auth/queries'
import type { User } from '../../entities/user'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Страница «Аккаунт» (/settings/account). Фаза 23 DEV-PLAN, слайс A: пока один
// раздел — профиль. Дальше сюда приезжают пароль, почта, второй фактор, способы
// входа и удаление аккаунта (docs/design/account-settings.md).
export const Route = createFileRoute('/_app/settings/account')({
  component: AccountPage,
})

// MAX_NAME_LEN зеркалит MaxPersonNameLen из internal/auth/service_account.go.
// Расхождение с сервером даст 422 на форме, которая считает себя валидной.
const MAX_NAME_LEN = 100

function AccountPage() {
  // Профиль уже в кэше — его положил гард _app; отдельного состояния загрузки
  // здесь быть не может.
  const { data: user } = useQuery(meQueryOptions)
  if (!user) return null
  // key по id: смена личности в той же вкладке (вход другим аккаунтом) обязана
  // сбрасывать черновик формы, иначе она покажет имя предыдущего пользователя.
  // Ремаунтом, а не эффектом-синхронизатором: setState в теле эффекта запрещён
  // линтом (react-hooks/set-state-in-effect) и даёт каскадный ререндер.
  return <AccountForm key={user.id} user={user} />
}

function AccountForm({ user }: { user: User }) {
  const update = useUpdateProfile()
  const [firstName, setFirstName] = useState(user.firstName)
  const [lastName, setLastName] = useState(user.lastName)

  const tooLong = firstName.length > MAX_NAME_LEN || lastName.length > MAX_NAME_LEN
  const dirty = firstName !== user.firstName || lastName !== user.lastName

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (tooLong) return
    update.mutate({ firstName, lastName })
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6">
      <section>
        <h1 className="text-lg font-medium">Аккаунт</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Как вас зовут и на какой адрес приходят письма.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="first-name" className="mb-2 block">
              Имя
            </Label>
            <Input
              id="first-name"
              value={firstName}
              maxLength={MAX_NAME_LEN}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Иван"
            />
          </div>
          <div>
            <Label htmlFor="last-name" className="mb-2 block">
              Фамилия
            </Label>
            <Input
              id="last-name"
              value={lastName}
              maxLength={MAX_NAME_LEN}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Петров"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="account-email" className="mb-2 block">
            Email
          </Label>
          {/* Адрес пока только показывается: смена — слайс D, и делать её видом
              редактируемого поля до того, как она работает, нельзя. */}
          <Input id="account-email" value={user.email} readOnly disabled />
          <p className="mt-2 text-sm text-muted-foreground">
            {user.emailVerified ? 'Адрес подтверждён.' : 'Адрес не подтверждён.'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!dirty || tooLong || update.isPending}>
            {update.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          {update.isSuccess && !dirty && (
            <span className="text-sm text-muted-foreground">Сохранено</span>
          )}
        </div>

        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            Не удалось сохранить. Попробуйте ещё раз.
          </p>
        )}
      </form>
    </div>
  )
}
