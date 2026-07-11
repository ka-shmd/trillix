import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { formDetailQueryOptions } from '../../features/forms/queries'

// Заглушка редактора (/forms/$formId/edit) — точка входа фазы 3. Пока показывает
// название и JSON черновика: доказательство, что форма и её схема загружаются.
export const Route = createFileRoute('/_app/forms/$formId/edit')({
  component: FormEditorStub,
})

function FormEditorStub() {
  const { formId } = Route.useParams()
  const query = useQuery(formDetailQueryOptions(formId))

  return (
    <section className="editor-stub">
      <p>
        <Link to="/forms">← К списку форм</Link>
      </p>

      {query.isPending ? (
        <p>Загрузка…</p>
      ) : query.isError ? (
        <div role="alert">
          <p>Форма не найдена.</p>
          <Link to="/forms">Вернуться к списку</Link>
        </div>
      ) : (
        <>
          <h1>{query.data.title}</h1>
          <p className="editor-stub-note">
            Билдер появится в фазе 3. Пока — черновик схемы формы:
          </p>
          <pre className="editor-stub-json">{JSON.stringify(query.data.draftSchema, null, 2)}</pre>
        </>
      )}
    </section>
  )
}
