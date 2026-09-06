import { createFileRoute, redirect } from '@tanstack/react-router'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { personalWorkspaceSlug } from '../../features/workspaces/current'

// Старый адрес редактора: закладки и ссылки, разосланные до того, как редактор стал
// адресоваться через пространство (`/w/{ws}/forms/{slug}/edit`, см. соседний файл —
// пространство ему нужно ради ЧЕРНОВИКА, который назвать его сам не может).
//
// Пространство спрашивается У САМОЙ ФОРМЫ: `GET /forms/{id}` несёт `workspaceSlug`.
// Угадывать его личным было бы ровно тем дефектом, ради которого адреса и менялись.
// Формы нет (удалена, чужая) — уводим в личное: редактор по этому адресу всё равно
// показал бы «форма не найдена», а список форм — рабочий экран.
export const Route = createFileRoute('/_app/forms/$slug/edit')({
  beforeLoad: async ({ context, params }) => {
    let workspaceSlug: string
    try {
      const form = await context.queryClient.ensureQueryData(formDetailQueryOptions(params.slug))
      workspaceSlug = form.workspaceSlug
    } catch {
      workspaceSlug = await personalWorkspaceSlug(context.queryClient)
    }
    throw redirect({
      to: '/w/$workspaceSlug/forms/$slug/edit',
      params: { workspaceSlug, slug: params.slug },
    })
  },
})
