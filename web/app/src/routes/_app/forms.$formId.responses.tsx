import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { type Block } from '@entities/formSchema'

import { formDetailQueryOptions } from '../../features/forms/queries'
import {
  submissionsListQueryOptions,
  useDeleteSubmission,
} from '../../features/submissions/queries'
import { submissionsExportUrl } from '../../features/submissions/api'
import { formatAnswer } from '../../features/submissions/answerFormat'
import { formatDate } from '../../shared/format'
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

// Таблица ответов формы (/forms/$formId/responses): курсорная подгрузка (новые
// сверху), клик по строке — панель полного ответа, экспорт в CSV, счётчик.
export const Route = createFileRoute('/_app/forms/$formId/responses')({
  component: ResponsesPage,
})

function ResponsesPage() {
  const { formId } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(formId))
  const list = useInfiniteQuery(submissionsListQueryOptions(formId))
  const [selected, setSelected] = useState<Submission | null>(null)

  const submissions = list.data?.pages.flatMap((p) => p.submissions) ?? []
  const total = list.data?.pages[0]?.total ?? 0
  const blocks = form.data?.draftSchema.blocks ?? []

  return (
    <section className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to="/forms"
            className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> К формам
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {form.data ? `Ответы · ${form.data.title}` : 'Ответы'}
          </h1>
          {!list.isPending && !list.isError && (
            <p className="mt-1 text-sm text-muted-foreground">
              {total === 0 ? 'Пока нет ответов' : `${total} ${plural(total)}`}
            </p>
          )}
        </div>
        {total > 0 && (
          // Обычная навигация: cookie авторизует, браузер качает файл (не fetch).
          <Button asChild variant="outline">
            <a href={submissionsExportUrl(formId)}>Экспорт CSV</a>
          </Button>
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
                  <TableHead>Отправлен</TableHead>
                  <TableHead>Версия</TableHead>
                  {blocks.map((b) => (
                    <TableHead key={b.id}>{blockTitle(b)}</TableHead>
                  ))}
                  <TableHead>
                    <span className="sr-only">Действия</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {submissions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="whitespace-nowrap">{formatDate(s.createdAt)}</TableCell>
                    <TableCell>{s.formVersion}</TableCell>
                    {blocks.map((b) => (
                      <TableCell key={b.id}>{formatAnswer(b, s.answers[b.id])}</TableCell>
                    ))}
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => setSelected(s)}>
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

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {selected && (
            <SubmissionPanel
              submission={selected}
              blocks={blocks}
              formId={formId}
              onClose={() => setSelected(null)}
            />
          )}
        </SheetContent>
      </Sheet>
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
      <SheetHeader>
        <SheetTitle>Ответ от {formatDate(submission.createdAt)}</SheetTitle>
        <SheetDescription>Версия формы: {submission.formVersion}</SheetDescription>
      </SheetHeader>

      <dl className="flex flex-col gap-4 px-4">
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

      <div className="mt-auto flex flex-col gap-2 px-4 pb-4">
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

function plural(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'ответ'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'ответа'
  return 'ответов'
}
