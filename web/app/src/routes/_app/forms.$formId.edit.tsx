import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { BuilderScreen } from '../../features/forms/builder/BuilderScreen'
import { Button } from '@/components/ui/button'

// Редактор формы (/forms/$formId/edit): грузит форму через Query и отдаёт билдеру.
// Название формы редактируется первой строкой полотна, не в этой шапке.
export const Route = createFileRoute('/_app/forms/$formId/edit')({
  component: FormEditor,
})

function FormEditor() {
  const { formId } = Route.useParams()
  const query = useQuery(formDetailQueryOptions(formId))

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="gap-1">
          <Link to="/forms">
            <ArrowLeft className="size-4" /> К формам
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/forms/$formId/responses" params={{ formId }}>
            Ответы
          </Link>
        </Button>
      </div>

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Загрузка…</p>
      ) : query.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Форма не найдена.</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/forms">Вернуться к списку</Link>
          </Button>
        </div>
      ) : (
        // key={formId} — свежий стор билдера на каждую форму.
        <div className="overflow-hidden rounded-xl border bg-card">
          <BuilderScreen key={formId} detail={query.data} />
        </div>
      )}
    </div>
  )
}
