import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Copy, Share2 } from 'lucide-react'

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
  //
  // 60/40, а не пополам: слева живёт сама ссылка — длинная строка в моноширинном
  // наборе плюс кнопка копирования, и в половине колонки адрес обрезался бы ровно
  // там, ради чего на экран и пришли. Справа картинка, которая тянется по ширине и
  // остаётся читаемой в любой из двух долей.
  return (
    <div className="grid gap-8 md:grid-cols-[3fr_2fr] md:items-start">
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
// ВХОД В НАСТРОЙКУ — СВОЯ СТРОКА ПОД ПОЯСНЕНИЕМ, а не кнопка в углу раздела: раздел
// показывает картинку, а не предлагает действие, и залитая кнопка спорила бы за
// внимание с «Копировать» — единственным здешним делом. Ссылка, а не абзац текста,
// потому что это единственное здесь нажимаемое; кнопка, а не <a>, — потому что
// открывает окно, а не ведёт по адресу. Подчёркивание постоянное, а не на наведении:
// строка стоит среди приглушённого текста и иначе не читается ссылкой.
//
// МЕТКА ПРО СТОИТ РЯДОМ СО ССЫЛКОЙ и ничего не запирает: настроить карточку можно на
// любом тарифе, применяется она только на платном (гейт — при отдаче публичной
// страницы, как у бейджа). Метка называет тариф и ведёт на страницу тарифов — то
// есть узнать цену можно тем же жестом, каким заметили ограничение. Место рядом со
// ссылкой, а не у заголовка: она помечает не раздел (превью видно всем), а ту
// возможность, к которой ссылка ведёт.
//
// ПРОСВЕТ РАЗДЕЛА СЖАТ ДО 4 (`className="gap-1"` перебивает `gap-6` Section через
// tailwind-merge): строка настройки — продолжение пояснения, а не следующий блок, и
// на обычных 24 она читалась бы подписью к карточке под ней. Шаг тот же, каким само
// пояснение отбито от заголовка.
function LinkPreview({ form }: { form: FormDetail }) {
  const [open, setOpen] = useState(false)

  return (
    <Section
      title="Превью ссылки"
      description="Отправляя ссылку, вы увидите карточку вроде такой — в соцсетях, мессенджерах и поисковой выдаче."
      className="gap-1"
    >
      {/* 16 между строкой настройки и карточкой — просвет «между элементами блока»
          из ритма кабинета (DESIGN-SYSTEM). */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          {/* Подчёркивание СНИМАЕТСЯ на наведении — тот же жест, что у ссылок
              полотна (BlockRow, CoverEditor): постоянная черта делает строку
              ссылкой, её исчезновение отвечает на курсор. */}
          <Button
            variant="link"
            className="h-auto p-0 text-sm underline hover:no-underline"
            onClick={() => setOpen(true)}
          >
            Настроить
          </Button>
          <ProTag />
        </div>
        <LinkPreviewCard form={form} preview={form.linkPreview} />
      </div>
      {/* Окно монтируется вместе с разделом, а не по клику: Radix сам держит его
          закрытым, а условный рендер терял бы набранное при каждом закрытии. */}
      <LinkPreviewDialog form={form} open={open} onOpenChange={setOpen} />
    </Section>
  )
}
