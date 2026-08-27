import { type Block, plainText } from '@entities/formSchema'
import { mediaSrc } from '@fields/media'
import { displayFormTitle, type FormDetail, type LinkPreview } from '../../entities/form'
import { publicFormHost } from './publicUrl'

// DEFAULT_PREVIEW_IMAGE — брендовая картинка, которую публичная страница ставит в
// og:image форме без своей (env OG_IMAGE_URL, deploy/README.md).
//
// ЗЕРКАЛО: web/app/public/og-preview.png — побайтовая копия
// web/renderer/public/og-preview.png. Копия, а не ссылка на домен рендерера, потому
// что прод-CSP кабинета режет чужие origin (`img-src 'self'`), а карточку надо
// показать до всякой публикации. Расхождение копий стережёт
// `linkPreviewImage.test.ts` — иначе кабинет однажды начал бы показывать не ту
// картинку, которую видит получатель ссылки.
const DEFAULT_PREVIEW_IMAGE = '/og-preview.png'

// DEFAULT_ICON — значок формы из разметки рендерера (web/renderer/index.html).
// Тот же файл лежит у кабинета своим фавиконом, поэтому зеркала здесь не заводится.
const DEFAULT_ICON = '/favicon.svg'

// LinkPreviewCard — карточка ссылки такой, какой её соберёт публичная страница:
// поля своей карточки поверх дефолтов. ОДИН компонент на два места (раздел
// «Поделиться» и окно настройки) намеренно: разъехавшись, они начали бы по-разному
// показывать одно и то же, и предпросмотр перестал бы что-либо доказывать.
//
// Точная отрисовка зависит от площадки — здесь общий знаменатель: имя площадки,
// заголовок, описание, картинка 1200×630.
export function LinkPreviewCard({
  form,
  preview,
}: {
  form: FormDetail
  preview: LinkPreview | null
}) {
  const siteName = preview?.siteName || publicFormHost()
  const title = preview?.title || displayFormTitle(form.title)
  const description = preview?.description || linkTeaser(form.draftSchema.blocks) || FALLBACK_TEASER
  const image = preview?.imageKey ? mediaSrc(preview.imageKey) : DEFAULT_PREVIEW_IMAGE
  const icon = preview?.iconKey ? mediaSrc(preview.iconKey) : DEFAULT_ICON

  return (
    // Полоска слева вместо рамки: она не обводит блок, а цитирует вид карточки,
    // которую рисуют мессенджеры. Серая, а не акцентная — акцент в кабинете значит
    // «сюда можно нажать», а это картинка.
    <div className="border-l-4 border-border pl-4">
      <div className="flex items-center gap-2">
        <img src={icon} alt="" className="size-4 shrink-0 rounded-xs object-contain" />
        <p className="truncate text-sm text-muted-foreground">{siteName}</p>
      </div>
      <p className="mt-1 text-base font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <img
        src={image}
        alt=""
        className="mt-2 aspect-[1200/630] w-full rounded-md border object-cover"
      />
    </div>
  )
}

// FALLBACK_TEASER — зеркалит domain.fallbackMetaDescription: описание страницы для
// формы, у которой ещё нет ни своего описания, ни заполненных подписей вопросов.
const FALLBACK_TEASER = 'Онлайн-форма — заполните и отправьте ответ.'

// linkTeaser — тизер карточки: заголовки первых трёх непустых блоков через « · ».
// Зеркалит серверный ogDescription (internal/forms/public_page.go), формирующий
// og:description опубликованной версии. Здесь считаем по текущему черновику —
// приближение, расходится с опубликованным лишь при неопубликованных правках.
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
