import { createFileRoute } from '@tanstack/react-router'

import { TemplatesView } from '../../features/forms/templates/TemplatesView'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'

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
        <TemplatesView workspaceId={workspace?.id} workspaceSlug={workspaceSlug} />
      </PageContainer>
    </>
  )
}
