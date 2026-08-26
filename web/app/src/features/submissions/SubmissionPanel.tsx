import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import { type AnswerColumn } from './columns'
import { answerFiles, formatAnswer } from './answerFormat'
import { DeleteSubmissionDialog } from './DeleteSubmissionDialog'
import { formatDateTime } from '../../shared/format'
import { type AnswerFile, type AnswerValue, type Submission } from '../../entities/submission'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Один ответ целиком: вопросы текущей схемы плюс ответы на вопросы прежних версий
// (block_id, которых в текущей схеме нет) — чтобы собранные данные не прятались.
//
// Подписи берутся из того же answerColumns, что и шапка таблицы: окно открывается
// ИЗ строки, и вопрос обязан называться в обоих местах одинаково. Колонок в таблице
// две, а вопросов здесь все: окно и есть способ увидеть ответ целиком.
//
// Удаление есть и здесь, и значком в строке таблицы: решение «этот ответ лишний»
// приходит и по двум первым ответам в строке, и по прочитанному целиком. Само окно
// подтверждения общее (`DeleteSubmissionDialog`) — два входа обязаны обещать одно.
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

      <Button
        variant="outline"
        className="self-start text-destructive hover:text-destructive"
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" />
        Удалить ответ
      </Button>

      <DeleteSubmissionDialog
        formId={formId}
        submission={submission}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
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
