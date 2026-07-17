import { useState } from 'react'
import { Link } from '@tanstack/react-router'

import { type Block } from '@entities/formSchema'
import { type Form, type FormDetail, displayFormTitle } from '../../entities/form'
import { publicFormUrl, publicFormHost } from './publicUrl'
import { usePublishForm, useUnpublishForm } from './queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ShareView — содержимое таба «Поделиться» (/forms/$slug/share). Открывается после
// публикации (редирект из шапки редактора) и табом у уже опубликованной формы.
// Две карточки (ссылка и её превью), внизу — управление жизненным циклом
// (перепубликация изменений, закрытие, повторная публикация закрытой).
// Шапка формы (назад, название, статус, «Редактировать») — на оболочке _manage.
export function ShareView({ form }: { form: FormDetail }) {
  const link = publicFormUrl(form.slug)
  const neverPublished = form.publishedVersion === null
  const isClosed = form.status === 'closed'

  return (
    <>
      {neverPublished ? (
        <div className="mx-auto mt-12 max-w-md text-center">
          <h2 className="text-lg font-medium">Форма ещё не опубликована</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Опубликуйте её в редакторе — здесь появятся ссылка и превью.
          </p>
          <Button asChild className="mt-4">
            <Link to="/forms/$slug/edit" params={{ slug: form.slug }}>
              Открыть редактор
            </Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <LinkBlock link={link} inactive={isClosed} />
            <PreviewBlock
              title={displayFormTitle(form.title)}
              host={publicFormHost()}
              teaser={linkTeaser(form.draftSchema.blocks)}
            />
          </div>
          <ManageSection form={form} />
        </>
      )}
    </>
  )
}

// LinkBlock — ссылка на форму с копированием и поясняющим текстом. Закрытая форма:
// ссылка остаётся видна, но помечаем, что приём ответов приостановлен.
function LinkBlock({ link, inactive }: { link: string; inactive: boolean }) {
  const [copied, setCopied] = useState(false)

  const onCopy = () => {
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        // Буфер недоступен — поле readonly, пользователь скопирует вручную.
      })
  }

  return (
    <div className="rounded-lg border p-5">
      <h2 className="text-base font-medium">Ссылка на форму</h2>
      <div className="mt-3 flex items-center gap-2">
        <Input
          readOnly
          value={link}
          aria-label="Ссылка на форму"
          onFocus={(e) => e.currentTarget.select()}
          className="h-9 font-mono text-xs"
        />
        <Button size="sm" onClick={onCopy}>
          {copied ? 'Готово' : 'Копировать'}
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {inactive
          ? 'Форма закрыта: по ссылке приём ответов приостановлен. Опубликуйте снова, чтобы принимать ответы.'
          : 'Отправьте эту ссылку респондентам — по ней откроется форма. Правки применяются только после повторной публикации.'}
      </p>
    </div>
  )
}

// linkTeaser — тизер карточки: заголовки первых трёх непустых блоков через « · ».
// Зеркалит серверный ogDescriptionFromSchema (internal/forms/public_page.go),
// формирующий og:description опубликованной версии. Здесь считаем по текущему
// черновику — приближение, расходится с опубликованным лишь при неопубликованных
// правках.
function linkTeaser(blocks: Block[]): string {
  const labels: string[] = []
  for (const b of blocks) {
    const label = b.label.trim()
    if (!label) continue
    labels.push(label)
    if (labels.length === 3) break
  }
  return labels.join(' · ')
}

// PreviewBlock — предпросмотр карточки ссылки, как её строит сервер из OG-мета
// (internal/forms/public_page.go, страница /r/{slug}): og:title = название формы,
// og:description = заголовки первых вопросов. Здесь — приближение того же вида
// (сервер дополнительно отдаёт og:image); точная отрисовка зависит от площадки.
function PreviewBlock({ title, host, teaser }: { title: string; host: string; teaser: string }) {
  return (
    <div className="rounded-lg border p-5">
      <h2 className="text-base font-medium">Как выглядит ссылка</h2>
      <div className="mt-3 rounded-md border bg-muted/30 p-3">
        <div className="border-l-2 border-primary pl-3">
          <p className="truncate text-xs text-muted-foreground">{host}</p>
          <p className="mt-0.5 font-medium">{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {teaser || 'Онлайн-форма — заполните и отправьте ответ.'}
          </p>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Так карточка выглядит при пересылке в мессенджерах и соцсетях: сервер отдаёт og:title
        (название) и og:description (заголовки первых вопросов). Точный вид зависит от площадки.
      </p>
    </div>
  )
}

// ManageSection — управление жизненным циклом опубликованной формы. Те же мутации,
// что раньше жили в поповере шапки: перепубликация изменившегося черновика и
// закрытие; у закрытой — повторная публикация.
function ManageSection({ form }: { form: Form }) {
  const publish = usePublishForm()
  const unpublish = useUnpublishForm()
  const busy = publish.isPending || unpublish.isPending
  const isClosed = form.status === 'closed'
  const hasChanges = form.status === 'published' && form.hasUnpublishedChanges

  return (
    <div className="mt-8 rounded-lg border p-5">
      <h2 className="text-base font-medium">Управление</h2>

      {isClosed ? (
        <>
          <p className="mt-1 text-sm text-muted-foreground">Форма закрыта — ответы не принимаются.</p>
          <Button className="mt-3" disabled={busy} onClick={() => publish.mutate(form.id)}>
            {publish.isPending ? 'Публикуем…' : 'Опубликовать снова'}
          </Button>
        </>
      ) : (
        <>
          {hasChanges && (
            <p className="mt-1 text-sm text-muted-foreground">
              Черновик изменился — опубликованная версия отстаёт от редактора.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {hasChanges && (
              <Button disabled={busy} onClick={() => publish.mutate(form.id)}>
                {publish.isPending ? 'Публикуем…' : 'Опубликовать изменения'}
              </Button>
            )}
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => unpublish.mutate(form.id)}
            >
              {unpublish.isPending ? 'Закрываем…' : 'Закрыть форму'}
            </Button>
          </div>
        </>
      )}

      {(publish.isError || unpublish.isError) && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {publish.isError
            ? 'Не удалось опубликовать. Проверьте, что у вопросов есть заголовки, а у вариантов — текст.'
            : 'Не удалось выполнить действие. Попробуйте ещё раз.'}
        </p>
      )}
    </div>
  )
}
