import { createFileRoute } from '@tanstack/react-router'

import { SubmissionsView } from '../../features/submissions/SubmissionsView'

// Вкладка «Все ответы» — отправленные и незавершённые одним списком по времени
// (спека §11). Незавершённые подмешивает сервер, и только если форма их собирает:
// у формы со снятым тумблером вкладка показывает то же, что «Законченные».
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions/all')({
  component: AllSubmissionsPage,
})

function AllSubmissionsPage() {
  const { slug } = Route.useParams()
  return <SubmissionsView slug={slug} kind="all" />
}
