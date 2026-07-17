import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { type Block, isAnswerableType } from '@entities/formSchema'

import { displayFormName } from '../../entities/form'
import { formDetailQueryOptions } from '../../features/forms/queries'
import {
  submissionsListQueryOptions,
  useDeleteSubmission,
} from '../../features/submissions/queries'
import { submissionsExportUrl } from '../../features/submissions/api'
import { formatAnswer } from '../../features/submissions/answerFormat'
import { formatDate, pluralAnswers } from '../../shared/format'
import { type Submission } from '../../entities/submission'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Таблица ответов формы (/forms/$slug/responses): курсорная подгрузка (новые
// сверху). В таблице только версия и дата заполнения; сами ответы — в диалоге,
// который открывается по строке. Плюс экспорт в CSV и счётчик.
export const Route = createFileRoute('/_app/forms/$slug/responses')({
  component: ResponsesPage,
})

function ResponsesPage() {
  // URL адресует форму slug'ом; UUID (formId) для запросов ответов берём из
  // загруженной формы. Список ответов ждёт, пока slug зарезолвится в id (enabled).
  const { slug } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const list = useInfiniteQuery({
    ...submissionsListQueryOptions(formId ?? ''),
    enabled: formId !== undefined,
  })
  // open управляет видимостью диалога, selected — какой ответ показываем. Не
  // обнуляем selected при закрытии: иначе содержимое пропадёт раньше, чем диалог
  // доиграет анимацию ухода. Оно остаётся смонтированным до следующего открытия.
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Submission | null>(null)

  function openSubmission(s: Submission) {
    setSelected(s)
    setOpen(true)
  }

  const submissions = list.data?.pages.flatMap((p) => p.submissions) ?? []
  const total = list.data?.pages[0]?.total ?? 0
  // Только отвечаемые блоки — колонки таблицы/панели. Неотвечаемые (text) ответов
  // не собирают, из выгрузки и таблицы исключены (зеркалит CSV на бэкенде).
  const blocks = (form.data?.draftSchema.blocks ?? []).filter((b) => isAnswerableType(b.type))

  return (
    <section className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to="/forms"
            className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> К формам
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {form.data ? `Ответы · ${displayFormName(form.data)}` : 'Ответы'}
          </h1>
          {!list.isPending && !list.isError && (
            <p className="mt-1 text-sm text-muted-foreground">
              {total === 0 ? 'Пока нет ответов' : `${total} ${pluralAnswers(total)}`}
            </p>
          )}
        </div>
        {total > 0 && formId && (
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/forms/$slug/summary" params={{ slug }}>
                Сводка
              </Link>
            </Button>
            {/* Обычная навигация: cookie авторизует, браузер качает файл (не fetch). */}
            <Button asChild variant="outline">
              <a href={submissionsExportUrl(formId)}>Экспорт CSV</a>
            </Button>
          </div>
        )}
      </header>

      {form.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Форма не найдена.</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/forms">Вернуться к списку</Link>
          </Button>
        </div>
      ) : list.isPending ? (
        <p className="text-sm text-muted-foreground">Загрузка ответов…</p>
      ) : list.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Не удалось загрузить ответы.</p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Повторить
          </Button>
        </div>
      ) : submissions.length === 0 ? (
        <div className="mx-auto mt-12 max-w-md text-center">
          <h2 className="text-lg font-medium">Ответов пока нет</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Опубликуйте форму и поделитесь ссылкой — ответы появятся здесь.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Заполнен</TableHead>
                  <TableHead>Версия</TableHead>
                  <TableHead>
                    <span className="sr-only">Действия</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {submissions.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => openSubmission(s)}
                  >
                    <TableCell className="whitespace-nowrap">{formatDate(s.createdAt)}</TableCell>
                    <TableCell>{s.formVersion}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          openSubmission(s)
                        }}
                      >
                        Открыть
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {list.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          {selected && formId && (
            <SubmissionPanel
              submission={selected}
              blocks={blocks}
              formId={formId}
              onClose={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

// SubmissionPanel — полный ответ: вопросы текущей схемы + ответы на вопросы прежних
// версий (block_id, которых нет в текущей схеме) — чтобы данные не прятались.
function SubmissionPanel({
  submission,
  blocks,
  formId,
  onClose,
}: {
  submission: Submission
  blocks: Block[]
  formId: string
  onClose: () => void
}) {
  const knownIds = new Set(blocks.map((b) => b.id))
  const extraIds = Object.keys(submission.answers).filter((id) => !knownIds.has(id))
  const remove = useDeleteSubmission(formId)

  function handleDelete() {
    // Список инвалидируется в onSuccess мутации; панель закрываем.
    remove.mutate(submission.id, { onSuccess: onClose })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Ответ от {formatDate(submission.createdAt)}</DialogTitle>
        <DialogDescription>Версия формы: {submission.formVersion}</DialogDescription>
      </DialogHeader>

      <dl className="flex flex-col gap-4">
        {blocks.map((b) => (
          <div key={b.id}>
            <dt className="text-sm font-medium">{blockTitle(b)}</dt>
            <dd className="mt-0.5 text-sm text-muted-foreground">
              {formatAnswer(b, submission.answers[b.id]) || '—'}
            </dd>
          </div>
        ))}
        {extraIds.map((id) => (
          <div key={id}>
            <dt className="text-sm font-medium">
              {id} <span className="text-muted-foreground">(из прежней версии)</span>
            </dt>
            <dd className="mt-0.5 text-sm text-muted-foreground">
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
          className="text-destructive hover:text-destructive"
          onClick={handleDelete}
          disabled={remove.isPending}
        >
          {remove.isPending ? 'Удаляем…' : 'Удалить ответ'}
        </Button>
      </div>
    </>
  )
}

function blockTitle(b: Block): string {
  return b.label.trim() || '(без названия)'
}

