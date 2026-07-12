import { useState } from 'react'
import { Share2 } from 'lucide-react'

import { type Form } from '../../../entities/form'
import { usePublishForm, useUnpublishForm } from '../queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// Базовый URL публичной части — из env (различие контуров живёт в конфигурации).
// В dev переменной обычно нет: fallback на локальный рендерер. Фаза 7 задаёт
// VITE_PUBLIC_BASE_URL на этапе сборки прод-контуров.
const PUBLIC_BASE =
  (import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined) ?? 'http://localhost:5174'

// Компактный контрол публикации для тонкой шапки редактора: «Опубликовать»
// (primary), а у опубликованной — «Поделиться» (поповер со ссылкой/копированием/
// закрытием) + отдельная кнопка «Опубликовать изменения», когда есть неопубликованные
// правки. Логика та же, что и раньше (те же мутации, оптимистичная блокировка).
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
    <div className="flex flex-wrap items-center justify-end gap-2">
      {isClosed && <span className="text-xs text-muted-foreground">Форма закрыта</span>}

      {isPublished && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Share2 className="size-4" /> Поделиться
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <p className="text-sm font-medium">Опубликовано · версия {form.publishedVersion}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Ссылка на форму для респондентов:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Input
                readOnly
                value={link}
                aria-label="Ссылка на форму"
                onFocus={(e) => e.currentTarget.select()}
                className="h-8 font-mono text-xs"
              />
              <Button size="sm" onClick={onCopy}>
                {copied ? 'Готово' : 'Копировать'}
              </Button>
            </div>
            {form.hasUnpublishedChanges && (
              <p className="mt-2 text-xs text-muted-foreground">
                Есть неопубликованные изменения — нажмите «Опубликовать изменения».
              </p>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => unpublish.mutate(form.id)}
              className="mt-2 w-full justify-start text-muted-foreground"
            >
              Закрыть форму
            </Button>
          </PopoverContent>
        </Popover>
      )}

      {needsPublish && (
        <Button
          size="sm"
          disabled={!canPublish || busy}
          onClick={() => publish.mutate(form.id)}
          title={!canPublish ? 'Дождитесь сохранения черновика' : undefined}
        >
          {publishLabel}
        </Button>
      )}

      {publish.isError && (
        <p className="w-full text-right text-xs text-destructive" role="alert">
          Не удалось опубликовать. Проверьте, что у вопросов есть заголовки, а у вариантов — текст.
        </p>
      )}
    </div>
  )
}
