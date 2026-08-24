import { createFileRoute, redirect } from '@tanstack/react-router'

// Старый адрес таблицы ответов. На него ведут письма-уведомления о новом ответе,
// уже ушедшие людям, — этот редирект переживает переезд экрана.
export const Route = createFileRoute('/_app/forms/$slug/_manage/responses')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/forms/$slug/submissions', params })
  },
})
