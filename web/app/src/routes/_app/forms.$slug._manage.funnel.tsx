import { createFileRoute, redirect } from '@tanstack/react-router'

// Старый адрес воронки — теперь вкладка «Отвалы» раздела «Аналитика».
export const Route = createFileRoute('/_app/forms/$slug/_manage/funnel')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/forms/$slug/insights/drop-offs', params, search: { period: 'all' } })
  },
})
