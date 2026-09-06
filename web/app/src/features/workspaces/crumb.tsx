import { Link } from '@tanstack/react-router'

import { useCurrentWorkspace } from './current'

// Корневая крошка кабинета — ПРОСТРАНСТВО, в котором человек находится, а не
// «Формы». Так путь остаётся верным, когда плоский список форм уйдёт: формы
// адресуются через пространство (`?w=`), и оно же есть контекст всех экранов.
//
// ПРОСТРАНСТВО БЕРЁТСЯ ИЗ АДРЕСА ЛИБО ИЗ САМОЙ ФОРМЫ — что из двух, решает
// `shared/workspaceContext.tsx`. Экраны формы пространства в пути не несут, и
// прямая ссылка на форму (закладка, письмо) читает его из детали, а не угадывает.
//
// `undefined` = список пространств ещё не приехал либо названное не наше. Крошки
// тогда нет вовсе: ссылка на «какое-нибудь» пространство хуже её отсутствия.
export function useWorkspaceCrumb(): React.ReactNode {
  const workspace = useCurrentWorkspace()

  if (!workspace) return '…'
  return (
    <Link to="/w/$workspaceSlug/forms" params={{ workspaceSlug: workspace.slug }}>
      {workspace.name}
    </Link>
  )
}
