import { useState } from 'react'
import { usePlanLink } from '../../shared/planLink'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { MAX_WORKSPACE_NAME_LEN } from '../../entities/workspace'
import { ApiError } from '../../shared/api/errors'
import { useCreateWorkspace } from './queries'
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

// Создание пространства — диалогом, а не формой в подвале страницы: список
// пространств растёт вниз, и кнопка «создать» уезжала бы от глаз тем дальше, чем
// больше их становится. Открывают его двое — «+» в блоке сайдбара и кнопка шапки
// обзора, поэтому диалог живёт в фиче, а не в файле маршрута.
//
// ЛИМИТ ТАРИФА СПРАШИВАЕТСЯ ОТКАЗОМ, А НЕ ЗАРАНЕЕ. Ключ `workspaces` —
// аккаунт-уровневый, и снимок тарифа воркспейса его намеренно не отдаёт
// (internal/entitlements/service.go, Snapshot: «показывать их здесь значило бы
// врать»). Поэтому «можно ли ещё одно» знает только POST /workspaces, а кабинет
// разбирает его 402: это не поломка, повторять бессмысленно — человека уносит на
// страницу тарифа, где написано, что он купил.
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const create = useCreateWorkspace()
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const planLink = usePlanLink()

  // Ни набранное, ни отказ не переживают закрытие: следующее открытие должно
  // начинаться с чистого поля, а не с прошлой попытки. Одной функцией на все
  // способы закрыться — крестик и Escape приходят Radix'ом, «Отмена» и отказ по
  // тарифу зовут её напрямую, и разъехаться этим путям нельзя.
  function close() {
    setName('')
    create.reset()
    onOpenChange(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (trimmed === '') return
    create.mutate(trimmed, {
      onSuccess: close,
      onError: (error) => {
        // Ветвимся по code, а не по тексту (web/CLAUDE.md): текст меняется, код —
        // контракт. Не про тариф — сообщение показывает сама форма ниже.
        if (!(error instanceof ApiError) || error.code !== 'plan_required') return
        close()
        toast.error('На текущем тарифе больше пространств завести нельзя.')
        void navigate(planLink)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Новое пространство</DialogTitle>
          <DialogDescription>
            Формы принадлежат пространству. Создатель становится его владельцем и может позвать
            коллег.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="workspace-name" className="mb-2 block">
              Название
            </Label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например, «Отдел маркетинга»"
              maxLength={MAX_WORKSPACE_NAME_LEN}
              autoFocus
            />
            {create.isError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                Не удалось создать пространство. Попробуйте ещё раз.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Отмена
            </Button>
            <Button type="submit" disabled={trimmed === '' || create.isPending}>
              {create.isPending ? 'Создаём…' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
