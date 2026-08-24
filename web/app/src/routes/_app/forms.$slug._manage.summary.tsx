import { createFileRoute, redirect } from '@tanstack/react-router'

// Старый адрес сводки. Живёт только ради закладок владельца: экраны переехали в
// раздел «Аналитика» (спека design/analytics-tally.md §3), а ссылка, отданная
// человеку однажды, ломаться не обязана.
export const Route = createFileRoute('/_app/forms/$slug/_manage/summary')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/forms/$slug/insights/answers', params, search: { period: 'all' } })
  },
})
