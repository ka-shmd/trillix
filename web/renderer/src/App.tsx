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
    case 'closed':
      // Форма была публичной, но приём закрыт (снята/дата/лимит): показываем её
      // название и текст владельца, а не безликое «недоступна» (шаг 4).
      return <StatusScreen title={state.title} detail={state.message} />
    case 'notfound':
      // Черновик и несуществующая форма неотличимы (404, инвариант 5) — один экран.
      return (
        <StatusScreen
          title="Форма недоступна"
          detail="Ссылка неверна или форма была удалена."
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
