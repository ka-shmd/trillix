import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { embedModeSchema, withoutMode, DEFAULT_EMBED_MODE } from '../../features/forms/embedSnippet'
import { EmbedView } from '../../features/forms/embed/EmbedView'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { ErrorState, LoadingRows } from '../../shared/page/states'

// Экран «Встроить» (/forms/{slug}/embed). ВНЕ группы `_manage` намеренно: у той
// колонка max-w-4xl и табы формы, а здесь не страница кабинета вовсе — отдельный
// режим во весь экран (решение владельца 2026-08-27): две области, слева настройки,
// справа макет чужой страницы. Ни крошек, ни шапки: и то и другое рисовало бы
// кабинет вокруг сцены, которая изображает ЧУЖОЙ сайт.
//
// Крошки остаются у ДВУХ состояний до режима — загрузки и отказа: их рисует сам
// кабинет, со своим верхним баром, и пустой бар над коробкой отказа не сообщал бы
// ничего (DESIGN-SYSTEM §3). Выход из режима подписан на самом слое.
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

  if (query.isError || query.isPending) {
    return (
      <>
        <PageCrumbs items={[workspaceCrumb, 'Встроить']} />
        <PageContainer>
          {query.isError ? (
            <ErrorState
              title="Форма не найдена."
              description="Возможно, её удалили или ссылка ведёт не туда."
            />
          ) : (
            <LoadingRows rows={2} />
          )}
        </PageContainer>
      </>
    )
  }

  return (
    <EmbedView
      form={query.data}
      mode={mode}
      onModeChange={(next) =>
        void navigate({ to: '.', search: (prev) => ({ ...prev, mode: next }), replace: true })
      }
      onClose={() =>
        // Вид вставки со страницы уходит вместе с режимом: за его пределами он не
        // значит ничего, а `?mode=block` иначе тянулся бы за человеком по разделам
        // формы и оставался в адресе, которым он поделится (`withoutMode`).
        void navigate({ to: '/forms/$slug/share', params: { slug }, search: withoutMode })
      }
    />
  )
}
