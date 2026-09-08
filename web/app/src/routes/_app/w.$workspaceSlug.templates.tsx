import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { TemplatesView } from '../../features/forms/templates/TemplatesView'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { EmptyState, LoadingRows } from '../../shared/page/states'

// Шаблоны форм (/w/{slug}/templates): встроенные заготовки, с которых начинают вместо
// пустого полотна.
//
// ПРОСТРАНСТВО В ПУТИ: галерея заводит форму, а форма обязана лечь туда, где её ждут.
// Пока экран стоял на `/templates`, пространство бралось из `?w=`, которого у ссылок
// на него не было, — и форма из шаблона всегда ложилась в личное.
export const Route = createFileRoute('/_app/w/$workspaceSlug/templates')({
  component: TemplatesPage,
})

// Пространство резолвит маршрут и отдаёт галерее пропом: путь называет его slug'ом,
// а ручка шаблонов ждёт id.
//
// МИНА. Галерея НЕ рисуется, пока перевод не сделан, и `workspaceId` приезжает к ней
// строкой, а не `string | undefined`. `useCurrentWorkspace()` отдаёт `undefined` в
// значении «ПОКА НЕ ЗНАЮ» (features/workspaces/current.ts), а отсутствие пространства
// в теле `POST /templates/{id}/use` сервер трактует как ЛИЧНОЕ — то есть форма из
// шаблона молча легла бы не туда, а кабинет увёл бы в редактор по адресу командного
// пространства. Тот же гейт и по той же причине стоит у списка форм.
function TemplatesPage() {
  const { workspaceSlug } = Route.useParams()
  const workspace = useCurrentWorkspace()
  // Список пространств спрашивается ради ОДНОГО ответа: приехал он или нет. Названное
  // путём и не найденное в нём — чужое или удалённое, и отличить это от «ещё грузится»
  // иначе нечем.
  const workspaces = useQuery(workspacesQueryOptions)
  const workspaceCrumb = useWorkspaceCrumb()
  return (
    // ДВА КОНТЕЙНЕРА ПОДРЯД, и ширины у них разные — тот же приём, что у оболочки
    // формы с таблицей ответов. Галерея — единственный раздел пространства, чьё
    // содержимое шире обычной колонки (решение владельца 2026-09-08,
    // DESIGN-SYSTEM §2): плитка теперь показывает саму форму, и в 896 их помещается
    // две, тогда как выбирают из шести. Шапка при этом остаётся в обычной колонке —
    // заголовок и описание во всю ширину монитора нечитаемы.
    <>
      <PageContainer className="pb-0">
        <PageCrumbs items={[workspaceCrumb, 'Шаблоны']} />
        <PageHeader
          title="Шаблоны"
          description="Готовая форма вместо пустого полотна: берёте заготовку — получаете свою форму со всеми вопросами, дальше правите как обычно."
        />
      </PageContainer>
      <PageContainer width="full" className="pt-0">
        {workspace ? (
          <TemplatesView workspaceId={workspace.id} workspaceSlug={workspaceSlug} />
        ) : workspaces.data ? (
          <EmptyState
            title="Такого пространства нет"
            description="Оно удалено или доступ к нему закрыт."
          />
        ) : (
          <LoadingRows className="mt-8" rows={2} />
        )}
      </PageContainer>
    </>
  )
}
