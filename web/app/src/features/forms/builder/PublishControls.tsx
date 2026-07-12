import { useState } from 'react'

import { type Form } from '../../../entities/form'
import { usePublishForm, useUnpublishForm } from '../queries'

// Базовый URL публичной части — из env (различие контуров живёт в конфигурации).
// В dev переменной обычно нет: fallback на локальный рендерер. Фаза 7 задаёт
// VITE_PUBLIC_BASE_URL на этапе сборки прод-контуров.
const PUBLIC_BASE =
  (import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined) ?? 'http://localhost:5174'

// Публикация формы в шапке билдера: кнопка «Опубликовать», статус/версия, ссылка
// на публичную форму с копированием, бейдж неопубликованных правок, «Закрыть
// форму». Читает живые поля формы из detail (кэш патчат мутации и автосейв).
//
// canPublish=false, пока есть несохранённые правки: публикация снимает снапшот
// серверного черновика, поэтому сначала он должен догнать редактор (автосейв).
export function PublishControls({ form, canPublish }: { form: Form; canPublish: boolean }) {
  const publish = usePublishForm()
  const unpublish = useUnpublishForm()
  const [copied, setCopied] = useState(false)

  const link = `${PUBLIC_BASE}/r/${form.slug}`
  const busy = publish.isPending || unpublish.isPending
  const isPublished = form.status === 'published'
  const isClosed = form.status === 'closed'
  const needsPublish = !isPublished || form.hasUnpublishedChanges

  const publishLabel = isClosed
    ? 'Опубликовать снова'
    : form.hasUnpublishedChanges
      ? 'Опубликовать изменения'
      : 'Опубликовать'

  const onCopy = () => {
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        // Буфер недоступен — поле ссылки readonly, пользователь скопирует вручную.
      })
  }

  return (
    <div className="publish">
      <div className="publish-row">
        {needsPublish && (
          <button
            type="button"
            className="publish-btn"
            disabled={!canPublish || busy}
            onClick={() => publish.mutate(form.id)}
          >
            {publishLabel}
          </button>
        )}

        {isPublished && (
          <span className="publish-status" role="status">
            Опубликовано · версия {form.publishedVersion}
          </span>
        )}
        {isClosed && (
          <span className="publish-status publish-status-closed" role="status">
            Закрыта{form.publishedVersion != null && ` · была версия ${form.publishedVersion}`}
          </span>
        )}

        {isPublished && form.hasUnpublishedChanges && (
          <span className="publish-badge">Есть неопубликованные изменения</span>
        )}

        {isPublished && (
          <button
            type="button"
            className="publish-close"
            disabled={busy}
            onClick={() => unpublish.mutate(form.id)}
          >
            Закрыть форму
          </button>
        )}
      </div>

      {isPublished && (
        <div className="publish-link">
          <input
            className="publish-link-input"
            type="text"
            readOnly
            value={link}
            aria-label="Ссылка на форму"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="publish-copy" onClick={onCopy}>
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
      )}

      {!canPublish && needsPublish && !busy && (
        <p className="publish-hint">Дождитесь сохранения черновика, чтобы опубликовать.</p>
      )}
      {publish.isError && (
        <p className="publish-error" role="alert">
          Не удалось опубликовать. Проверьте, что у вопросов есть заголовки, а у вариантов — текст.
        </p>
      )}
    </div>
  )
}
