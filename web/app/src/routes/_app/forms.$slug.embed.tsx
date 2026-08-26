import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { embedModeSchema, DEFAULT_EMBED_MODE } from '../../features/forms/embedSnippet'
import { EmbedView } from '../../features/forms/embed/EmbedView'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { displayFormTitle } from '../../entities/form'

// Экран «Встроить» (/forms/{slug}/embed). ВНЕ группы `_manage` намеренно: у той
// колонка max-w-4xl и табы формы, а здесь нужен весь экран — панель настроек и
// страница-макет рядом. Возврат — «Закрыть» на «Поделиться», откуда сюда и приходят.
//
// Вид вставки — в адресе: три кнопки на «Поделиться» ведут каждая на свой, ссылка
// на «форму виджетом» сохраняется в закладки, «Назад» браузера работает. Мусор в
// параметре гасит catch — умолчание вместо упавшего экрана. `w` (текущее
// пространство) проносится через search, как во всех ссылках кабинета.
const embedSearchSchema = z.object({
  mode: embedModeSchema.optional().catch(undefined),
  w: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_app/forms/$slug/embed')({
  validateSearch: embedSearchSchema,
  component: EmbedPage,
})

function EmbedPage() {
  const { slug } = Route.useParams()
  const { mode = DEFAULT_EMBED_MODE } = Route.useSearch()
  const navigate = useNavigate()
  const query = useQuery(formDetailQueryOptions(slug))
  const workspaceCrumb = useWorkspaceCrumb()

  if (query.isError) {
    return (
      <div
        role="alert"
        className="m-6 rounded-lg border border-destructive/40 bg-destructive/5 p-6"
      >
        <p className="text-sm">Форма не найдена.</p>
      </div>
    )
  }
  if (!query.data) {
    return <p className="p-6 text-sm text-muted-foreground">Загрузка…</p>
  }

  return (
    <>
      <PageCrumbs
        items={[
          workspaceCrumb,
          <Link key="form" to="/forms/$slug/share" params={{ slug }} search={(prev) => prev}>
            {displayFormTitle(query.data.title)}
          </Link>,
          'Встроить',
        ]}
      />
      <EmbedView
        form={query.data}
        mode={mode}
        onModeChange={(next) =>
          void navigate({ to: '.', search: (prev) => ({ ...prev, mode: next }), replace: true })
        }
        onClose={() =>
          void navigate({ to: '/forms/$slug/share', params: { slug }, search: (prev) => prev })
        }
      />
    </>
  )
}
