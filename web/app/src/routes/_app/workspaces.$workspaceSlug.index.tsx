import { createFileRoute, redirect } from '@tanstack/react-router'

// Старый адрес страницы пространства. Отдельного экрана «пространство» больше нет:
// корень пространства — его список форм, и обе страницы показывали одно и то же.
export const Route = createFileRoute('/_app/workspaces/$workspaceSlug/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/w/$workspaceSlug/forms', params })
  },
})
