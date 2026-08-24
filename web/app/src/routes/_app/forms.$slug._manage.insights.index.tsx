import { createFileRoute, redirect } from '@tanstack/react-router'

// /forms/$slug/insights без вкладки — на сводку. Раздел сам по себе экрана не
// имеет: у него всегда открыта одна из вкладок.
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/')({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/forms/$slug/insights/answers', params, search })
  },
})
