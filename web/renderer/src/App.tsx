import { useEffect } from 'react'

import { type HostBridge } from './features/form/embed'
import { FormView } from './features/form/FormView'
import { slugFromPath } from './features/form/slug'
import { usePublicForm } from './features/form/usePublicForm'

// Корень рендерера: slug из pathname → загрузка → форма либо статус-экран.
// bridge не null, когда страница открыта во фрейме на чужом сайте (фаза 20).
export function App({ bridge }: { bridge: HostBridge | null }) {
  useHostHeight(bridge)
  const slug = slugFromPath(window.location.pathname)
  const state = usePublicForm(slug)

  switch (state.status) {
    case 'loading':
      return <StatusScreen title="Загрузка формы…" />
    case 'ok':
      return <FormView slug={slug} form={state.form} bridge={bridge} />
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

// useHostHeight — высота фрейма следует за высотой содержимого: во встроенном блоке
// внутреннего скролла нет, страницу-хозяина прокручивает сам хост.
//
// Наблюдаем BODY, а не documentElement: у <html> высота не меньше вьюпорта фрейма,
// поэтому раз выросший фрейм уже никогда бы не уменьшился — измеренная высота
// осталась бы равной его собственной. Живёт здесь, а не в FormView: сообщать размер
// обязаны и статус-экраны (закрытая форма во фрейме не должна занимать экран).
//
// Режим 'page' не наблюдаем вовсе: там фрейм ростом с вьюпорт хоста и скроллится сам.
function useHostHeight(bridge: HostBridge | null) {
  useEffect(() => {
    if (bridge === null || bridge.mode === 'page') return
    const body = document.body
    const send = () => bridge.resize(Math.ceil(body.getBoundingClientRect().height))
    const observer = new ResizeObserver(send)
    observer.observe(body)
    send()
    return () => observer.disconnect()
  }, [bridge])
}

function StatusScreen({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="status">
      <h1 className="status-title">{title}</h1>
      {detail && <p className="status-detail">{detail}</p>}
    </main>
  )
}
