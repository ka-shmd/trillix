import { createFileRoute } from '@tanstack/react-router'

import { PartialsView } from '../../features/submissions/PartialsView'

// Вкладка «Частичные» — то, что респондент набрал и не отправил
// (`partial_submissions`). Сбор включается тумблером формы за платным тарифом,
// поэтому у вкладки два состояния: предложение включить и список — оба в PartialsView.
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions/partial')({
  component: PartialSubmissionsPage,
})

function PartialSubmissionsPage() {
  const { slug } = Route.useParams()
  return <PartialsView slug={slug} />
}
