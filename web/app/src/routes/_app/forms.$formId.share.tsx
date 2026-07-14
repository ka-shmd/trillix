import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { ShareView } from '../../features/forms/ShareView'
import { Button } from '@/components/ui/button'

// Страница «Поделиться» (/forms/$formId/share): ссылка на опубликованную форму,
// превью карточки и управление публикацией. Данные — та же деталь формы из Query,
// что и у редактора; здесь нужны только поля карточки (title/slug/status/версия).
export const Route = createFileRoute('/_app/forms/$formId/share')({
  component: SharePage,
})

function SharePage() {
  const { formId } = Route.useParams()
  const query = useQuery(formDetailQueryOptions(formId))

  if (query.isPending) {
    return <p className="p-6 text-sm text-muted-foreground">Загрузка…</p>
  }
  if (query.isError) {
    return (
      <div role="alert" className="m-6 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
        <p className="mb-3 text-sm">Форма не найдена.</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/forms">Вернуться к списку</Link>
        </Button>
      </div>
    )
  }

  return <ShareView form={query.data} />
}
