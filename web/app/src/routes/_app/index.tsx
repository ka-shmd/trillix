import { createFileRoute, redirect } from '@tanstack/react-router'

import { personalWorkspaceSlug } from '../../features/workspaces/current'

// Домашний экран приложения (/) — редирект в личное пространство: список его форм и
// есть главная. Пространство называется В ПУТИ, поэтому корню приходится его узнать
// (`GET /workspaces` всё равно читается сайдбаром на каждом экране — запрос не лишний).
export const Route = createFileRoute('/_app/')({
  beforeLoad: async ({ context }) => {
    throw redirect({
      to: '/w/$workspaceSlug/forms',
      params: { workspaceSlug: await personalWorkspaceSlug(context.queryClient) },
    })
  },
})
