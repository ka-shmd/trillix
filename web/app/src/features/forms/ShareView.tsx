import { Link } from '@tanstack/react-router'
import { Share2 } from 'lucide-react'

import { type Block, plainText } from '@entities/formSchema'
import { type Form, type FormDetail, displayFormTitle } from '../../entities/form'
import { planRequiredMessage } from '../plan/planError'
import { copyFormLink } from './copyLink'
import { EmbedSection } from './EmbedSection'
import { publicFormUrl, publicFormHost } from './publicUrl'
import { usePublishForm, useUnpublishForm } from './queries'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

// ShareView — содержимое таба «Поделиться» (/forms/$slug/share). Открывается после
// публикации (редирект из шапки редактора) и табом у уже опубликованной формы.
// Колонку, заголовок формы и табы даёт оболочка _manage — здесь только разделы.
export function ShareView({ form }: { form: FormDetail }) {
  const isClosed = form.status === 'closed'

  // Неопубликованная форма — не «страница без данных», а страница, которой ещё нет
  // смысла: ссылки не существует, встраивать нечего, управлять нечем. Поэтому вместо
  // пустых разделов один вход в редактор.
  if (form.publishedVersion === null) {
    return (
      <EmptyState
        icon={Share2}
        title="Форма ещё не опубликована"
        description="Опубликуйте её в редакторе — здесь появятся ссылка, карточка для мессенджеров и код для вставки на сайт."
        action={
          <Button asChild>
            <Link to="/forms/$slug/edit" params={{ slug: form.slug }} search={(prev) => prev}>
              Открыть редактор
            </Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-12">
      <LinkSection form={form} inactive={isClosed} />
      {/* Закрытой форме встраивать нечего: фрейм покажет «приём закрыт». */}
      {!isClosed && <EmbedSection form={form} />}
      <ManageSection form={form} />
    </div>
  )
}

// LinkSection — сама ссылка и то, как её увидят при пересылке. Один раздел, а не два
// соседних: превью карточки объясняет ту же ссылку, и разводить их по разным
// заголовкам значит спрашивать у человека, чем «Ссылка» отличается от «Как выглядит
// ссылка».
function LinkSection({ form, inactive }: { form: FormDetail; inactive: boolean }) {
  const link = publicFormUrl(form.slug)

  return (
    <Section
      title="Ссылка на форму"
      description={
        inactive
          ? 'Форма закрыта: по ссылке приём ответов приостановлен. Опубликуйте снова, чтобы принимать ответы.'
          : 'Отправьте её респондентам — по ней откроется форма. Правки применяются только после повторной публикации.'
      }
    >
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={link}
          aria-label="Ссылка на форму"
          onFocus={(e) => e.currentTarget.select()}
          className="h-10 font-mono text-sm md:text-sm"
        />
        {/* Копирование ведёт себя одинаково везде — общая точка с баром формы и её
            меню действий (features/forms/copyLink.ts). */}
        <Button onClick={() => copyFormLink(form.slug)}>Копировать</Button>
      </div>

      <LinkPreview
        title={displayFormTitle(form.title)}
        host={publicFormHost()}
        teaser={linkTeaser(form.draftSchema.blocks)}
      />
    </Section>
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
    // Тизер — из блоков-подписей (title/label), как og:description на бэке.
    if (b.type !== 'title' && b.type !== 'label') continue
    // Тизер — текст, не разметка (фаза 14): как og:description на бэке.
    const label = plainText(b.text).trim()
    if (!label) continue
    labels.push(label)
    if (labels.length === 3) break
  }
  return labels.join(' · ')
}

// LinkPreview — предпросмотр карточки ссылки, как её строит сервер из OG-мета
// (internal/forms/public_page.go, страница /r/{slug}): og:title = название формы,
// og:description = заголовки первых вопросов. Здесь — приближение того же вида
// (сервер дополнительно отдаёт og:image); точная отрисовка зависит от площадки.
function LinkPreview({ title, host, teaser }: { title: string; host: string; teaser: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Card className="max-w-md gap-0 bg-muted/30 p-4">
        <div className="border-l-2 border-primary pl-3">
          <p className="truncate text-sm text-muted-foreground">{host}</p>
          <p className="mt-1 text-base font-semibold">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {teaser || 'Онлайн-форма — заполните и отправьте ответ.'}
          </p>
        </div>
      </Card>
      <p className="text-sm text-muted-foreground">
        Так карточка выглядит при пересылке в мессенджерах и соцсетях. Точный вид зависит от
        площадки.
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
    <Section
      title="Управление"
      description={
        isClosed
          ? 'Форма закрыта — ответы не принимаются.'
          : hasChanges
            ? 'Черновик изменился — опубликованная версия отстаёт от редактора.'
            : undefined
      }
    >
      <div className="flex flex-wrap gap-2">
        {isClosed ? (
          <Button disabled={busy} onClick={() => publish.mutate(form.id)}>
            {publish.isPending ? 'Публикуем…' : 'Опубликовать снова'}
          </Button>
        ) : (
          <>
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
          </>
        )}
      </div>

      {(publish.isError || unpublish.isError) && (
        // Перепубликация — вторая точка того же гейта, и общий текст про заголовки
        // вопросов на отказе по тарифу прямо врал: автор шёл чинить то, что не
        // сломано. Сообщение сервера здесь то же, что в шапке редактора, и берётся
        // одним помощником — разъехавшись, две точки объясняли бы один 402 по-разному.
        <ErrorState
          title={
            planRequiredMessage(publish.error) ??
            (publish.isError
              ? 'Не удалось опубликовать. Проверьте, что у вопросов есть заголовки, а у вариантов — текст.'
              : 'Не удалось выполнить действие. Попробуйте ещё раз.')
          }
        />
      )}
    </Section>
  )
}
