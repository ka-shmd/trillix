import { Link } from '@tanstack/react-router'
import { Share2 } from 'lucide-react'

import { type Block, plainText } from '@entities/formSchema'
import { type FormDetail, displayFormTitle } from '../../entities/form'
import { copyFormLink } from './copyLink'
import { EmbedSection } from './EmbedSection'
import { publicFormUrl, publicFormHost } from './publicUrl'
import { Section } from '../../shared/page/Section'
import { EmptyState } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
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
    </div>
  )
}

// LinkSection — сама ссылка и то, как её увидят при пересылке. Один раздел, а не два
// соседних: превью карточки объясняет ту же ссылку, и разводить их по разным
// заголовкам значит спрашивать у человека, чем «Ссылка» отличается от «Как выглядит
// ссылка».
function LinkSection({ form, inactive }: { form: FormDetail; inactive: boolean }) {
  const link = publicFormUrl(form.slug)

  // Превью — СОСЕДНИЙ РАЗДЕЛ, а не содержимое этого: колонки заведены выше Section,
  // поэтому оба заголовка стоят на одной линии.
  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] md:items-start">
      <Section
        title="Ссылка на форму"
        description={
          inactive
            ? 'Форма закрыта: по ссылке приём ответов приостановлен. Опубликуйте её снова в редакторе, чтобы принимать ответы.'
            : 'Форма опубликована и готова к отправке. Скопируйте ссылку, чтобы поделиться ею в соцсетях, мессенджерах или по почте.'
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
      </Section>

      <LinkPreview
        title={displayFormTitle(form.title)}
        host={publicFormHost()}
        teaser={linkTeaser(form.draftSchema.blocks)}
      />
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
    <Section
      title="Превью ссылки"
      description="Так карточка выглядит при пересылке в мессенджерах и соцсетях. Точный вид зависит от площадки."
    >
      {/* Ни фона, ни рамки — только полоска слева: она не обводит блок, а цитирует
          вид карточки, которую рисуют мессенджеры. Серая, а не акцентная: акцент в
          кабинете значит «сюда можно нажать», а это картинка. */}
      <div className="border-l-4 border-border pl-4">
        <p className="truncate text-sm text-muted-foreground">{host}</p>
        <p className="mt-1 text-base font-semibold">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {teaser || 'Онлайн-форма — заполните и отправьте ответ.'}
        </p>
      </div>
    </Section>
  )
}
