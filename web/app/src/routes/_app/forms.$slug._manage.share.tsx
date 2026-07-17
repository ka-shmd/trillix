import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { ShareView } from '../../features/forms/ShareView'

// Таб «Поделиться» (/forms/$slug/share): ссылка на опубликованную форму, превью
// карточки и управление публикацией. Данные — та же деталь формы из Query, что и у
// редактора; здесь нужны только поля карточки (title/slug/status/версия).
//
// Шапка (назад, название, статус, «Редактировать»), табы и экран «форма не найдена»
// — на оболочке _manage, поэтому здесь остался только pending.
export const Route = createFileRoute('/_app/forms/$slug/_manage/share')({
  component: SharePage,
})

function SharePage() {
  const { slug } = Route.useParams()
  const query = useQuery(formDetailQueryOptions(slug))

  if (!query.data) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>
  }
  return <ShareView form={query.data} />
}
