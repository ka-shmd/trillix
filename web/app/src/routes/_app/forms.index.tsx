import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

import { formsSortSchema } from '../../entities/form'
import { personalWorkspaceSlug } from '../../features/workspaces/current'

// Старый адрес списка форм. Живёт только редиректом: у владельца на него закладки,
// а `?w=<slug>` стоит в ссылках, разосланных до переезда пространства в путь.
//
// Параметр здесь читается В ПОСЛЕДНИЙ РАЗ и дальше по кабинету не разносится —
// именно его потеря и означала «личное пространство» молча
// (`docs/design/cabinet-navigation.md` §2).
const legacySearch = z.object({
  q: z.string().optional().catch(undefined),
  sort: formsSortSchema.optional().catch(undefined),
  w: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_app/forms/')({
  validateSearch: legacySearch,
  beforeLoad: async ({ context, search }) => {
    throw redirect({
      to: '/w/$workspaceSlug/forms',
      params: {
        workspaceSlug: search.w ?? (await personalWorkspaceSlug(context.queryClient)),
      },
      search: { q: search.q, sort: search.sort },
    })
  },
})
