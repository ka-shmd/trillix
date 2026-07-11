import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { BuilderScreen } from '../../features/builder/BuilderScreen'

// Редактор формы (/forms/$formId/edit): грузит форму через Query и отдаёт билдеру.
export const Route = createFileRoute('/_app/forms/$formId/edit')({
  component: FormEditor,
})

function FormEditor() {
  const { formId } = Route.useParams()
  const query = useQuery(formDetailQueryOptions(formId))

  return (
    <div className="builder-page">
      <header className="builder-topbar">
        <Link to="/forms">← К формам</Link>
        {query.data && <span className="builder-title">{query.data.title}</span>}
      </header>

      {query.isPending ? (
        <p className="builder-loading">Загрузка…</p>
      ) : query.isError ? (
        <div role="alert" className="builder-error-box">
          <p>Форма не найдена.</p>
          <Link to="/forms">Вернуться к списку</Link>
        </div>
      ) : (
        // key={formId} — свежий стор билдера на каждую форму.
        <BuilderScreen key={formId} detail={query.data} />
      )}
    </div>
  )
}
