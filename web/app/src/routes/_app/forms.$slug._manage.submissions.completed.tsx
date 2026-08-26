import { createFileRoute } from '@tanstack/react-router'

import { SubmissionsView } from '../../features/submissions/SubmissionsView'

// Вкладка «Законченные» — отправленные ответы, то есть таблица `submissions`.
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions/completed')({
  component: CompletedSubmissionsPage,
})

function CompletedSubmissionsPage() {
  const { slug } = Route.useParams()
  return <SubmissionsView slug={slug} />
}
