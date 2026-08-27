import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Copy, Share2, SlidersHorizontal } from 'lucide-react'

import { type FormDetail } from '../../entities/form'
import { copyFormLink } from './copyLink'
import { EmbedSection } from './EmbedSection'
import { LinkPreviewCard } from './LinkPreviewCard'
import { LinkPreviewDialog } from './LinkPreviewDialog'
import { publicFormUrl } from './publicUrl'
import { Section } from '../../shared/page/Section'
import { EmptyState } from '../../shared/page/states'
import { ProTag } from '../../shared/ProTag'
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
    <div className="grid gap-8 md:grid-cols-2 md:items-start">
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
          <Button variant="utility" className="gap-2" onClick={() => copyFormLink(form.slug)}>
            <Copy className="size-4" />
            Копировать
          </Button>
        </div>
      </Section>

      <LinkPreview form={form} />
    </div>
  )
}

// LinkPreview — раздел «Превью ссылки»: карточка, какой её увидит получатель, и
// вход в её настройку. Кнопка ведёт в окно, а не разворачивает поля здесь: полей
// пять, у каждого свой предпросмотр, и в колонке шириной в половину экрана они
// вытеснили бы саму ссылку — то, ради чего на экран и пришли.
//
// МЕТКА ПРО СТОИТ У КНОПКИ, а не запирает её: настроить карточку можно на любом
// тарифе, применяется она только на платном (гейт — при отдаче публичной страницы,
// как у бейджа). Метка называет тариф и ведёт на страницу тарифов — то есть узнать
// цену можно тем же жестом, каким заметили ограничение.
function LinkPreview({ form }: { form: FormDetail }) {
  const [open, setOpen] = useState(false)

  return (
    <Section
      title="Превью ссылки"
      description="Отправляя ссылку, вы увидите карточку вроде такой — в соцсетях, мессенджерах и поисковой выдаче."
      action={
        <div className="flex items-center gap-2">
          <ProTag />
          <Button variant="utility" className="gap-2" onClick={() => setOpen(true)}>
            <SlidersHorizontal className="size-4" />
            Настроить
          </Button>
        </div>
      }
    >
      <LinkPreviewCard form={form} preview={form.linkPreview} />
      {/* Окно монтируется вместе с разделом, а не по клику: Radix сам держит его
          закрытым, а условный рендер терял бы набранное при каждом закрытии. */}
      <LinkPreviewDialog form={form} open={open} onOpenChange={setOpen} />
    </Section>
  )
}
