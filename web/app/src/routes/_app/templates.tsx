import { createFileRoute } from '@tanstack/react-router'

import { TemplatesView } from '../../features/forms/templates/TemplatesView'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { PageCrumbs } from '../../shared/page/headerPortals'

// Шаблоны форм (/templates): встроенные заготовки, с которых начинают вместо пустого
// полотна. Входов два — пункт сайдбара и ссылка «Использовать шаблон» на пустом
// полотне (SlashEditor, EmptyStarter).
export const Route = createFileRoute('/_app/templates')({
  component: TemplatesPage,
})

// Пространство резолвит маршрут и отдаёт галерее пропом: адрес называет его
// slug'ом, а `POST /forms` ждёт id.
function TemplatesPage() {
  const workspace = useCurrentWorkspace()
  return (
    <>
      <PageCrumbs items={['Шаблоны']} />
      <TemplatesView workspaceId={workspace?.id} />
    </>
  )
}
