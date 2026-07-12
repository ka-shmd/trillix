import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
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
    <section className="responses-page">
      <header className="responses-header">
        <div>
          <Link to="/forms">← К формам</Link>
          <h1>{form.data ? `Ответы · ${form.data.title}` : 'Ответы'}</h1>
          {!list.isPending && !list.isError && (
            <p className="responses-count">
              {total === 0 ? 'Пока нет ответов' : `${total} ${plural(total)}`}
            </p>
          )}
        </div>
        {total > 0 && (
          // Обычная навигация: cookie авторизует, браузер качает файл (не fetch).
          <a className="button" href={submissionsExportUrl(formId)}>
            Экспорт CSV
          </a>
        )}
      </header>

      {form.isError ? (
        <div role="alert" className="responses-error">
          <p>Форма не найдена.</p>
          <Link to="/forms">Вернуться к списку</Link>
        </div>
      ) : list.isPending ? (
        <p className="responses-loading">Загрузка ответов…</p>
      ) : list.isError ? (
        <div role="alert" className="responses-error">
          <p>Не удалось загрузить ответы.</p>
          <button type="button" onClick={() => list.refetch()}>
            Повторить
          </button>
        </div>
      ) : submissions.length === 0 ? (
        <div className="empty-state">
          <h2>Ответов пока нет</h2>
          <p>Опубликуйте форму и поделитесь ссылкой — ответы появятся здесь.</p>
        </div>
      ) : (
        <>
          <div className="responses-table-wrap">
            <table className="responses-table">
              <thead>
                <tr>
                  <th scope="col">Отправлен</th>
                  <th scope="col">Версия</th>
                  {blocks.map((b) => (
                    <th key={b.id} scope="col">
                      {blockTitle(b)}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="visually-hidden">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDate(s.createdAt)}</td>
                    <td>{s.formVersion}</td>
                    {blocks.map((b) => (
                      <td key={b.id}>{formatAnswer(b, s.answers[b.id])}</td>
                    ))}
                    <td>
                      <button type="button" onClick={() => setSelected(s)}>
                        Открыть
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {list.hasNextPage && (
            <div className="responses-more">
              <button
                type="button"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </button>
            </div>
          )}
        </>
      )}

      {selected && (
        <SubmissionPanel
          submission={selected}
          blocks={blocks}
          formId={formId}
          onClose={() => setSelected(null)}
        />
      )}
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
    if (window.confirm('Удалить этот ответ? Действие необратимо.')) {
      // Список инвалидируется в onSuccess мутации; панель закрываем.
      remove.mutate(submission.id, { onSuccess: onClose })
    }
  }

  return (
    <aside className="submission-panel" aria-label="Полный ответ">
      <div className="submission-panel-head">
        <h2>Ответ от {formatDate(submission.createdAt)}</h2>
        <button type="button" onClick={onClose} aria-label="Закрыть">
          ✕
        </button>
      </div>
      <p className="submission-panel-meta">Версия формы: {submission.formVersion}</p>

      <dl className="submission-answers">
        {blocks.map((b) => (
          <div key={b.id}>
            <dt>{blockTitle(b)}</dt>
            <dd>{formatAnswer(b, submission.answers[b.id]) || <span className="muted">—</span>}</dd>
          </div>
        ))}
        {extraIds.map((id) => (
          <div key={id}>
            <dt>
              {id} <span className="muted">(из прежней версии)</span>
            </dt>
            <dd>{formatAnswer(undefined, submission.answers[id])}</dd>
          </div>
        ))}
      </dl>

      <div className="submission-panel-foot">
        {remove.isError && (
          <p role="alert" className="submission-panel-error">
            Не удалось удалить. Попробуйте ещё раз.
          </p>
        )}
        <button type="button" className="danger" onClick={handleDelete} disabled={remove.isPending}>
          {remove.isPending ? 'Удаляем…' : 'Удалить ответ'}
        </button>
      </div>
    </aside>
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
