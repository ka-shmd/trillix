import { useState } from 'react'
import { MAX_WORKSPACE_NAME_LEN, type Workspace } from '../../entities/workspace'
import { useRenameWorkspace } from './queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Переименование пространства из САЙДБАРА — окном, а не правкой прямо в строке,
// как на обзоре: строка сайдбара шириной в 16rem и уже занята шевроном и двумя
// кнопками, поле с «Сохранить/Отмена» в неё не помещается.
//
// Пустое имя не отправляем — совпадает с серверной валидацией (имя обязательно,
// потолок MAX_WORKSPACE_NAME_LEN рун).
export function RenameWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const rename = useRenameWorkspace(workspace.id)
  const [name, setName] = useState(workspace.name)
  const trimmed = name.trim()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Открытие начинается с ТЕКУЩЕГО имени, а не с недонабранного прошлого:
        // окно предлагает правку, а не продолжение брошенной попытки.
        if (next) {
          setName(workspace.name)
          rename.reset()
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Переименовать пространство</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (trimmed === '') return
            rename.mutate(trimmed, { onSuccess: () => onOpenChange(false) })
          }}
        >
          <div>
            <Label htmlFor="rename-workspace-dialog" className="mb-2 block">
              Название
            </Label>
            <Input
              id="rename-workspace-dialog"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_WORKSPACE_NAME_LEN}
              autoFocus
            />
            {rename.isError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                Не удалось переименовать пространство. Попробуйте ещё раз.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={trimmed === '' || rename.isPending}>
              {rename.isPending ? 'Сохраняем…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
