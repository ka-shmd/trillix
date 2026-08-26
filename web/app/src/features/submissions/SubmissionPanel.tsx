import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import { type AnswerColumn } from './columns'
import { answerFiles, formatAnswer } from './answerFormat'
import { useDeleteSubmission } from './queries'
import { formatDateTime } from '../../shared/format'
import { type AnswerFile, type AnswerValue, type Submission } from '../../entities/submission'
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
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Один ответ целиком: вопросы текущей схемы плюс ответы на вопросы прежних версий
// (block_id, которых в текущей схеме нет) — чтобы собранные данные не прятались.
//
// Подписи берутся из того же answerColumns, что и шапка таблицы: окно открывается
// ИЗ строки, и вопрос обязан называться в обоих местах одинаково. Колонок в таблице
// две, а вопросов здесь все: окно и есть способ увидеть ответ целиком.
//
// Удаление живёт ЗДЕСЬ, потому что здесь видно, что удаляют: у строки таблицы
// показаны два первых ответа, и «удалить» по ней — это удалить неизвестно что.
// Подтверждение обязательно: действие необратимо и уносит чужие данные
// (docs/DESIGN-SYSTEM.md §7).
export function SubmissionPanel({
  submission,
  columns,
  files,
  formId,
  onDeleted,
}: {
  submission: Submission
  columns: AnswerColumn[]
  files: Record<string, AnswerFile>
  formId: string
  onDeleted: () => void
}) {
  const knownIds = new Set(columns.map((c) => c.block.id))
  const extraIds = Object.keys(submission.answers).filter((id) => !knownIds.has(id))
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteSubmission(formId)

  return (
    <>
      <DialogHeader>
        <DialogTitle>Ответ от {formatDateTime(submission.createdAt)}</DialogTitle>
        <DialogDescription>Версия формы: {submission.formVersion}</DialogDescription>
      </DialogHeader>

      <dl className="flex flex-col gap-4">
        {columns.map((c) => (
          <div key={c.block.id}>
            <dt className="text-sm font-medium">{c.label}</dt>
            <dd className="mt-0.5 text-sm break-words text-muted-foreground">
              {c.block.type === 'file' ? (
                <FileLinks value={submission.answers[c.block.id]} files={files} />
              ) : (
                formatAnswer(c.block, submission.answers[c.block.id]) || '—'
              )}
            </dd>
          </div>
        ))}
        {extraIds.map((id) => (
          <div key={id}>
            <dt className="text-sm font-medium">
              {id} <span className="text-muted-foreground">(из прежней версии)</span>
            </dt>
            <dd className="mt-0.5 text-sm break-words text-muted-foreground">
              {formatAnswer(undefined, submission.answers[id])}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-2">
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            Не удалось удалить. Попробуйте ещё раз.
          </p>
        )}
        <Button
          variant="outline"
          className="self-start text-destructive hover:text-destructive"
          onClick={() => setConfirming(true)}
          disabled={remove.isPending}
        >
          <Trash2 className="size-4" />
          {remove.isPending ? 'Удаляем…' : 'Удалить ответ'}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Удалить ответ от {formatDateTime(submission.createdAt)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Это действие необратимо. Ответ исчезнет из таблицы, выгрузки и сводки.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                // Список инвалидируется в onSuccess мутации; окно закрываем.
                remove.mutate(submission.id, { onSuccess: onDeleted })
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// FileLinks — приложенные файлы ссылками на скачивание. Ссылка ведёт на НАШ
// эндпоинт, а не на хранилище: подпись живёт минуту, и вшитая в разметку она
// протухла бы, пока автор читает ответ. Скачивание — обычная навигация, поэтому
// download и target здесь не нужны: сервер отдаёт вложение сам.
function FileLinks({
  value,
  files,
}: {
  value: AnswerValue | undefined
  files: Record<string, AnswerFile>
}) {
  const items = answerFiles(value, files)
  if (items.length === 0) return <>—</>
  return (
    <ul className="flex flex-col gap-1">
      {items.map((f) => (
        <li key={f.id}>
          <a className="text-primary underline underline-offset-4" href={`/api/v1/files/${f.id}`}>
            {f.name}
          </a>
        </li>
      ))}
    </ul>
  )
}
