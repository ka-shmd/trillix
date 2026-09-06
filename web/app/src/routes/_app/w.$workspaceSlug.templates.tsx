import { createFileRoute } from '@tanstack/react-router'

import { TemplatesView } from '../../features/forms/templates/TemplatesView'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { PageCrumbs } from '../../shared/page/headerPortals'

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
// а `POST /forms` ждёт id.
function TemplatesPage() {
  const { workspaceSlug } = Route.useParams()
  const workspace = useCurrentWorkspace()
  const workspaceCrumb = useWorkspaceCrumb()
  return (
    <>
      <PageCrumbs items={[workspaceCrumb, 'Шаблоны']} />
      <TemplatesView workspaceId={workspace?.id} workspaceSlug={workspaceSlug} />
    </>
  )
}
