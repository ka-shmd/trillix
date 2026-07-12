import { FormView } from './features/form/FormView'
import { slugFromPath } from './features/form/slug'
import { usePublicForm } from './features/form/usePublicForm'

// Корень рендерера: slug из pathname → загрузка → форма либо статус-экран.
export function App() {
  const slug = slugFromPath(window.location.pathname)
  const state = usePublicForm(slug)

  switch (state.status) {
    case 'loading':
      return <StatusScreen title="Загрузка формы…" />
    case 'ok':
      return <FormView slug={slug} form={state.form} />
    case 'notfound':
      // Черновик, закрытая и несуществующая форма неотличимы (404) — один экран.
      return (
        <StatusScreen
          title="Форма недоступна"
          detail="Ссылка неверна или форма больше не принимает ответы."
        />
      )
    case 'error':
      return (
        <StatusScreen
          title="Не удалось загрузить форму"
          detail="Проверьте соединение и обновите страницу."
        />
      )
  }
}

function StatusScreen({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="status">
      <h1 className="status-title">{title}</h1>
      {detail && <p className="status-detail">{detail}</p>}
    </main>
  )
}
