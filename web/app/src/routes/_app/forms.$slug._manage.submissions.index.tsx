import { createFileRoute, redirect } from '@tanstack/react-router'

// /forms/$slug/submissions без вкладки — на «Все ответы». Раздел сам по себе экрана не
// имеет: у него всегда открыта одна из вкладок. Сюда же приходит редирект со старого
// /responses, на который ведут уже разосланные письма о новых ответах.
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions/')({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/forms/$slug/submissions/all', params, search })
  },
})
