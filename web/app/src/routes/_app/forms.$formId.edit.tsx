import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { BuilderScreen } from '../../features/forms/builder/BuilderScreen'
import { Button } from '@/components/ui/button'

// Редактор формы (/forms/$formId/edit): грузит форму через Query и отдаёт билдеру.
// Вся навигация/публикация — в шапке BuilderScreen; название правится первой
// строкой полотна. Здесь только загрузка/ошибка и чистое полотно во всю ширину.
export const Route = createFileRoute('/_app/forms/$formId/edit')({
  component: FormEditor,
})

function FormEditor() {
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

  // key={formId} — свежий стор билдера на каждую форму.
  return <BuilderScreen key={formId} detail={query.data} />
}
