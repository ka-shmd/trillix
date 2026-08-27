import { mediaSrc } from '@fields/media'
import { resolveLinkPreview, type FormDetail, type LinkPreview } from '../../entities/form'

// DEFAULT_PREVIEW_IMAGE — брендовая картинка, которую публичная страница ставит в
// og:image форме без своей (env OG_IMAGE_URL, deploy/README.md).
//
// ЗЕРКАЛО: web/app/public/og-preview.png — побайтовая копия
// web/renderer/public/og-preview.png. Копия, а не ссылка на домен рендерера, потому
// что прод-CSP кабинета режет чужие origin (`img-src 'self'`), а карточку надо
// показать до всякой публикации. Расхождение копий стережёт `check-docs.sh`.
const DEFAULT_PREVIEW_IMAGE = '/og-preview.png'

// DEFAULT_ICON — значок формы из разметки рендерера (web/renderer/index.html).
// Тот же файл лежит у кабинета своим фавиконом, поэтому зеркала здесь не заводится.
const DEFAULT_ICON = '/favicon.svg'

// LinkPreviewCard — карточка ссылки такой, какой её соберёт публичная страница:
// поля своей карточки поверх дефолтов (подстановка — resolveLinkPreview, зеркало
// getHTML). ОДИН компонент на два места (раздел «Поделиться» и окно настройки)
// намеренно: разъехавшись, они начали бы по-разному показывать одно и то же, и
// предпросмотр перестал бы что-либо доказывать.
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
  const shown = resolveLinkPreview(form, preview)
  const image = shown.imageKey ? mediaSrc(shown.imageKey) : DEFAULT_PREVIEW_IMAGE
  const icon = shown.iconKey ? mediaSrc(shown.iconKey) : DEFAULT_ICON

  return (
    // Полоска слева вместо рамки: она не обводит блок, а цитирует вид карточки,
    // которую рисуют мессенджеры. Серая, а не акцентная — акцент в кабинете значит
    // «сюда можно нажать», а это картинка.
    <div className="border-l-4 border-border pl-4">
      <div className="flex items-center gap-2">
        <img src={icon} alt="" className="size-4 shrink-0 rounded-xs object-contain" />
        <p className="truncate text-sm text-muted-foreground">{shown.siteName}</p>
      </div>
      <p className="mt-1 text-base font-semibold">{shown.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{shown.description}</p>
      <img
        src={image}
        alt=""
        className="mt-2 aspect-[1200/630] w-full rounded-md border object-cover"
      />
    </div>
  )
}
