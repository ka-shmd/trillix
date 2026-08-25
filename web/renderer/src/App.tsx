import { useEffect } from 'react'

import { Badge } from '@fields/Badge'
import { type EmbedOptions, type HostBridge } from './features/form/embed'
import { FormView } from './features/form/FormView'
import { slugFromPath } from './features/form/slug'
import { usePublicForm } from './features/form/usePublicForm'

// Корень рендерера: slug из pathname → загрузка → форма либо статус-экран.
// bridge не null, когда страница открыта во фрейме на чужом сайте (фаза 20).
export function App({
  bridge,
  embed,
}: {
  bridge: HostBridge | null
  /** Параметры вставки; null — форма открыта прямой ссылкой, а не во фрейме. */
  embed: EmbedOptions | null
}) {
  useHostHeight(bridge)
  const slug = slugFromPath(window.location.pathname)
  // Предпросмотр автора решается здесь, а не в FormView: от него зависит, запрашивать
  // ли токен формы, а это делает загрузчик.
  const state = usePublicForm(slug, embed?.preview ?? false)

  switch (state.status) {
    case 'loading':
      return <StatusScreen title="Загрузка формы…" />
    case 'ok':
      return (
        <FormView
          slug={slug}
          form={state.form}
          token={state.token}
          bridge={bridge}
          embed={embed}
        />
      )
    case 'closed':
      // Форма была публичной, но приём закрыт (снята/дата/лимит): показываем её
      // название и текст владельца, а не безликое «недоступна» (шаг 4).
      return <StatusScreen title={state.title} detail={state.message} badge={state.showBadge} />
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

// badge — только там, где сервер о нём высказался. На «Загрузке», «Форма
// недоступна» и ошибке его нет намеренно: схемы мы не получили, чья это форма и что
// разрешает её тариф — неизвестно, а бейдж на чужой опечатке в адресе никому не
// нужен.
function StatusScreen({
  title,
  detail,
  badge = false,
}: {
  title: string
  detail?: string
  badge?: boolean
}) {
  return (
    <main className="status">
      <h1 className="status-title">{title}</h1>
      {detail && <p className="status-detail">{detail}</p>}
      {badge && <Badge />}
    </main>
  )
}
