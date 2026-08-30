import { useState } from 'react'
import { FileDown, Loader2, Trash2 } from 'lucide-react'

import { toast } from 'sonner'

import { type AnswerColumn } from './columns'
import { downloadSubmissionPdf } from './api'
import { answerFiles, formatAnswer } from './answerFormat'
import { DeleteAnswerDialog } from './DeleteAnswerDialog'
import { ROW_WORDS, type AnswerRow } from './rows'
import { formatDateTime } from '../../shared/format'
import { type AnswerFile, type AnswerValue } from '../../entities/submission'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Одна запись целиком — отправленный ответ или незавершённый: вопросы текущей схемы
// плюс ответы на вопросы прежних версий (block_id, которых в текущей схеме нет) —
// чтобы собранные данные не прятались.
//
// Подписи берутся из того же answerColumns, что и шапка таблицы: окно открывается
// ИЗ строки, и вопрос обязан называться в обоих местах одинаково. Колонок в таблице
// две, а вопросов здесь все: окно и есть способ увидеть запись целиком.
//
// Удаление есть и здесь, и значком в строке таблицы: решение «эта запись лишняя»
// приходит и по двум первым ответам в строке, и по прочитанному целиком. Само окно
// подтверждения общее (`DeleteAnswerDialog`) — два входа обязаны обещать одно.
export function SubmissionPanel({
  row,
  columns,
  files,
  formId,
  onDeleted,
}: {
  row: AnswerRow
  columns: AnswerColumn[]
  files: Record<string, AnswerFile>
  formId: string
  onDeleted: () => void
}) {
  const knownIds = new Set(columns.map((c) => c.block.id))
  const extraIds = Object.keys(row.answers).filter((id) => !knownIds.has(id))
  const [confirming, setConfirming] = useState(false)
  const [printing, setPrinting] = useState(false)
  const words = ROW_WORDS[row.kind]
  // Вопрос, на котором человек остановился, — единственное, что есть у черновика и
  // нет у ответа. Подписью, а не строкой списка: это не ответ на вопрос, а место
  // ухода, и в одном ряду с ответами оно читалось бы как ещё один ответ.
  const stoppedAt = columns.find((c) => c.block.id === row.lastBlockId)

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {words.one} от {formatDateTime(row.at)}
        </DialogTitle>
        <DialogDescription>
          Версия формы: {row.formVersion}
          {stoppedAt && ` · остановился на вопросе «${stoppedAt.label}»`}
        </DialogDescription>
      </DialogHeader>

      <dl className="flex flex-col gap-4">
        {columns.map((c) => (
          <div key={c.block.id}>
            <dt className="text-sm font-medium">{c.label}</dt>
            <dd className="mt-0.5 text-sm break-words text-muted-foreground">
              {c.block.type === 'file' ? (
                <FileLinks value={row.answers[c.block.id]} files={files} />
              ) : (
                formatAnswer(c.block, row.answers[c.block.id]) || '—'
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
              {formatAnswer(undefined, row.answers[id])}
            </dd>
          </div>
        ))}
      </dl>

      {/* Два действия в одну строку: печать и удаление. Печать — только у
          отправленного ответа, по тому же доводу, что и в строке таблицы. Оба входа
          в печать ведут в одну функцию (`api.downloadSubmissionPdf`) — обещать в
          окне и в строке разные файлы было бы нельзя. */}
      <div className="flex flex-wrap items-center gap-2">
        {row.kind !== 'partial' && (
          <Button
            variant="outline"
            disabled={printing}
            onClick={() => {
              setPrinting(true)
              downloadSubmissionPdf(formId, row.id)
                .catch((err: unknown) =>
                  toast.error(err instanceof Error ? err.message : 'Не удалось напечатать ответ.'),
                )
                .finally(() => setPrinting(false))
            }}
          >
            {printing ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
            Скачать PDF
          </Button>
        )}
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-4" />
          Удалить {words.oneLower}
        </Button>
      </div>

      <DeleteAnswerDialog
        formId={formId}
        row={row}
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
