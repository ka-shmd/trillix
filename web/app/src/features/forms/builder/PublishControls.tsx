import { useState } from 'react'

import { type Form } from '../../../entities/form'
import { usePublishForm, useUnpublishForm } from '../queries'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

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
    <div className="flex flex-col gap-2 border-b bg-muted/30 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        {needsPublish && (
          <Button
            size="sm"
            disabled={!canPublish || busy}
            onClick={() => publish.mutate(form.id)}
          >
            {publishLabel}
          </Button>
        )}

        {isPublished && (
          <span className="text-sm text-muted-foreground" role="status">
            Опубликовано · версия {form.publishedVersion}
          </span>
        )}
        {isClosed && (
          <span className="text-sm text-muted-foreground" role="status">
            Закрыта{form.publishedVersion != null && ` · была версия ${form.publishedVersion}`}
          </span>
        )}

        {isPublished && form.hasUnpublishedChanges && (
          <Badge variant="secondary">Есть неопубликованные изменения</Badge>
        )}

        {isPublished && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => unpublish.mutate(form.id)}>
            Закрыть форму
          </Button>
        )}
      </div>

      {isPublished && (
        <div className="flex items-center gap-2">
          <Input
            type="text"
            readOnly
            value={link}
            aria-label="Ссылка на форму"
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 max-w-md font-mono text-xs"
          />
          <Button size="sm" variant="outline" onClick={onCopy}>
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        </div>
      )}

      {!canPublish && needsPublish && !busy && (
        <p className="text-xs text-muted-foreground">
          Дождитесь сохранения черновика, чтобы опубликовать.
        </p>
      )}
      {publish.isError && (
        <p className="text-sm text-destructive" role="alert">
          Не удалось опубликовать. Проверьте, что у вопросов есть заголовки, а у вариантов — текст.
        </p>
      )}
    </div>
  )
}
