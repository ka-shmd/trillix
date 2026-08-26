import { createFileRoute } from '@tanstack/react-router'

import { SubmissionsTabs } from '../../features/submissions/SubmissionsTabs'
import { EmptyState } from '../../shared/page/states'

// Вкладка «Частичные» — черновики того, что респондент набрал и не отправил
// (`partial_submissions`). ЗАГЛУШКА: сбор идёт, а ручки на чтение ещё нет — её делает
// следующая задача (слайс H спеки design/analytics-tally.md §11).
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions/partial')({
  component: PartialSubmissionsPage,
})

function PartialSubmissionsPage() {
  const { slug } = Route.useParams()

  return (
    <div className="flex flex-col gap-4">
      <SubmissionsTabs slug={slug} />
      <EmptyState
        title="Черновиков пока нет"
        description="Здесь появятся ответы, которые начали заполнять и не отправили. Собирать их форма начинает, когда включён тумблер «Сохранять незавершённые ответы»."
      />
    </div>
  )
}
