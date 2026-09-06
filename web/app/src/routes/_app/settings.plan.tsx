import { createFileRoute, redirect } from '@tanstack/react-router'

import { personalWorkspaceSlug } from '../../features/workspaces/current'
import { recallWorkspaceSlug } from '../../shared/currentWorkspace'

// Старый адрес страницы тарифа: закладки владельца и ссылки, разосланные до переезда
// тарифа в пространство.
//
// Куда вести, адрес не говорит — пространства в нём нет. Спрашиваем память оболочки
// (последнее пространство, НАЗВАННОЕ адресом или формой), а её отсутствие означает
// личное. Это единственное место, где память решает навигацию, и цена ошибки здесь
// нулевая: страница только читает, а её собственный адрес пространство называет.
export const Route = createFileRoute('/_app/settings/plan')({
  beforeLoad: async ({ context }) => {
    throw redirect({
      to: '/w/$workspaceSlug/plan',
      params: {
        workspaceSlug: recallWorkspaceSlug() ?? (await personalWorkspaceSlug(context.queryClient)),
      },
    })
  },
})
