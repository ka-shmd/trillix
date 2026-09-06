import { createFileRoute, redirect } from '@tanstack/react-router'

import { personalWorkspaceSlug } from '../../features/workspaces/current'

// Старый адрес галереи шаблонов. Пространства он не называл вовсе, поэтому ведёт в
// личное — туда же, куда молча клала форму сама галерея по этому адресу.
export const Route = createFileRoute('/_app/templates')({
  beforeLoad: async ({ context }) => {
    throw redirect({
      to: '/w/$workspaceSlug/templates',
      params: { workspaceSlug: await personalWorkspaceSlug(context.queryClient) },
    })
  },
})
