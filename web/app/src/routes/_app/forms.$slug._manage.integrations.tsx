import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { displayFormName } from '../../entities/form'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { IntegrationsView } from '../../features/integrations/IntegrationsView'

// Таб «Интеграции» (/forms/$slug/integrations): куда уезжают ответы этой формы.
//
// Свой маршрут, как у соседей: табы обязаны быть маршрутами, а не локальным
// стейтом — иначе ссылка на экран не сохраняется в закладки, а «Назад» браузера
// уводит со страницы формы целиком (оболочка _manage).
export const Route = createFileRoute('/_app/forms/$slug/_manage/integrations')({
  component: IntegrationsPage,
})

function IntegrationsPage() {
  // URL адресует форму slug'ом; UUID для запроса берём из загруженной формы —
  // как на страницах ответов, сводки и воронки.
  const { slug } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(slug))

  if (!form.data) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>
  }
  return <IntegrationsView formId={form.data.id} formName={displayFormName(form.data)} />
}
