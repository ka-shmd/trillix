import { createFileRoute, redirect } from '@tanstack/react-router'

import { DEFAULT_PERIOD } from '../../shared/period'

// Старый адрес воронки — теперь «Обзор», первая вкладка раздела «Аналитика».
export const Route = createFileRoute('/_app/forms/$slug/_manage/funnel')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/forms/$slug/insights',
      params,
      search: { period: DEFAULT_PERIOD },
    })
  },
})
