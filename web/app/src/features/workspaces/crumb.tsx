import { Link } from '@tanstack/react-router'

import { useCurrentWorkspace } from './current'

// Корневая крошка кабинета — ПРОСТРАНСТВО, в котором человек находится, а не
// «Формы». Так путь остаётся верным, когда плоский список форм уйдёт: формы
// адресуются через пространство (`?w=`), и оно же есть контекст всех экранов.
//
// ПРОСТРАНСТВО БЕРЁТСЯ ИЗ АДРЕСА, А НЕ ИЗ ФОРМЫ: `formSchema` не несёт
// `workspaceId` (его нет и в ответе API), поэтому прямая ссылка на форму без `?w=`
// покажет личное пространство, даже если форма командная. Это существующее
// поведение кабинета — по тому же адресу так же ошибается подсветка сайдбара и
// кнопка «Новая форма»; крошка его не создаёт, а делает видимым (TECH-DEBT).
//
// `undefined` = список пространств ещё не приехал либо slug в адресе не наш. Тогда
// крошка ведёт на общий список форм: он верен в любом случае.
export function useWorkspaceCrumb(): React.ReactNode {
  const workspace = useCurrentWorkspace()

  if (!workspace) {
    return (
      <Link to="/forms" search={(prev) => prev}>
        Формы
      </Link>
    )
  }
  return (
    <Link to="/workspaces/$workspaceSlug" params={{ workspaceSlug: workspace.slug }}>
      {workspace.name}
    </Link>
  )
}
