import { createFileRoute } from '@tanstack/react-router'

import { SubmissionsView } from '../../features/submissions/SubmissionsView'

// Вкладка «Все ответы» — оба потока одним списком по времени (спека §11). Пока черновики
// не читаются ручкой, второго потока нет, и вкладка показывает то же, что «Законченные».
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions/all')({
  component: AllSubmissionsPage,
})

function AllSubmissionsPage() {
  const { slug } = Route.useParams()
  return <SubmissionsView slug={slug} />
}
