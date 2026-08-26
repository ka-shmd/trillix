import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { submissionsListQueryOptions } from '../../features/submissions/queries'
import { submissionsExportUrl } from '../../features/submissions/api'
import { answerColumns, previewColumns, versionsDiffer } from '../../features/submissions/columns'
import { SubmissionPanel } from '../../features/submissions/SubmissionPanel'
import { SubmissionsTable } from '../../features/submissions/SubmissionsTable'
import { FormStats } from '../../features/forms/FormStats'
import { pluralAnswers } from '../../shared/format'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { type AnswerFile, type Submission } from '../../entities/submission'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'

// Таблица ответов формы (/forms/$slug/submissions): курсорная подгрузка, новые
// сверху, строка — один ответ, колонка — один вопрос. Клик по строке открывает
// ответ целиком (там же и удаление); выгрузка всего — кнопкой раздела.
//
// Шапка страницы, крошки и табы — на оболочке _manage: своей шапки экран не рисует.
// Колонка страницы у этой вкладки без потолка ширины (`full`) — её выбирает та же
// оболочка по открытому маршруту.
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions')({
  component: SubmissionsPage,
})

function SubmissionsPage() {
  // URL адресует форму slug'ом; UUID (formId) для запросов ответов берём из
  // загруженной формы. Список ответов ждёт, пока slug зарезолвится в id (enabled).
  const { slug } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const list = useInfiniteQuery({
    ...submissionsListQueryOptions(formId ?? ''),
    enabled: formId !== undefined,
  })
  // open управляет видимостью окна, selected — какой ответ показываем. Не обнуляем
  // selected при закрытии: иначе содержимое пропадёт раньше, чем окно доиграет
  // анимацию ухода. Оно остаётся смонтированным до следующего открытия.
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Submission | null>(null)

  function openSubmission(s: Submission) {
    setSelected(s)
    setOpen(true)
  }

  const submissions = list.data?.pages.flatMap((p) => p.submissions) ?? []
  const total = list.data?.pages[0]?.total ?? 0
  // Ответы, скрытые квотой тарифа. Показываем ЧИСЛОМ и словами «сохранены»:
  // человек собрал эти данные, и молчаливая пропажа читается как потеря.
  const hidden = list.data?.pages[0]?.hidden ?? 0
  // Имена приложенных файлов приходят рядом со страницей (в самих ответах лежат
  // только id загрузок). Страниц может быть несколько — карты сливаются.
  const files = Object.assign({}, ...(list.data?.pages ?? []).map((p) => p.files)) as Record<
    string,
    AnswerFile
  >
  const columns = answerColumns(form.data?.draftSchema.blocks ?? [])

  return (
    <div className="flex flex-col gap-8">
      {hidden > 0 && (
        <div role="status" className="rounded-lg bg-warning/10 p-4 text-sm">
          <p className="font-medium">
            {hidden} {pluralAnswers(hidden)} скрыто — исчерпан лимит тарифа.
          </p>
          <p className="mt-1 text-muted-foreground">
            Они сохранены и откроются сразу после перехода на тариф, который их вмещает.
          </p>
        </div>
      )}

      <Section
        title="Все ответы"
        description={
          list.isSuccess ? (
            // Знаменатель к числу ответов: без него «12 ответов» не отличить от
            // «12 из 900 открывших» (фаза 8.5 шаг 6). У черновика просмотров нет —
            // там остаётся голый счётчик.
            form.data && form.data.status !== 'draft' ? (
              <FormStats
                visits={form.data.visitCount}
                submittedVisits={form.data.visitSubmittedCount}
                submissions={total}
              />
            ) : (
              `${total} ${pluralAnswers(total)}`
            )
          ) : (
            'Каждая строка — один заполненный ответ.'
          )
        }
        action={
          total > 0 &&
          formId && (
            // Обычная навигация: cookie авторизует, браузер качает файл (не fetch).
            <Button asChild variant="outline" size="sm">
              <a href={submissionsExportUrl(formId)}>Экспорт CSV</a>
            </Button>
          )
        }
      >
        {list.isPending ? (
          <LoadingRows rows={4} />
        ) : list.isError ? (
          <ErrorState title="Не удалось загрузить ответы." onRetry={() => void list.refetch()} />
        ) : submissions.length === 0 ? (
          <EmptyState
            title="Ответов пока нет"
            description="Опубликуйте форму и поделитесь ссылкой — ответы появятся здесь."
          />
        ) : (
          <div className="flex flex-col gap-6">
            <SubmissionsTable
              rows={submissions}
              columns={previewColumns(columns)}
              files={files}
              showVersion={versionsDiffer(submissions)}
              onOpen={openSubmission}
            />
            {list.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          {selected && (
            <SubmissionPanel
              submission={selected}
              columns={columns}
              files={files}
              formId={formId ?? ''}
              onDeleted={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
