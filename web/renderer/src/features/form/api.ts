import { z } from 'zod'

import { formSchemaSchema } from '@entities/formSchema'

// Тело GET /public/v1/forms/{slug} (см. docs/API.md). schema валидируется тем же
// контрактом, что и в кабинете, — непровалидированный any внутрь не проходит
// (web/CLAUDE.md). token — подписанное время выдачи (антиспам фазы 5), пока
// просто хранится для будущей отправки.
const publicFormSchema = z.object({
  title: z.string(),
  version: z.number().int(),
  schema: formSchemaSchema,
  token: z.string(),
})
export type PublicForm = z.infer<typeof publicFormSchema>

// Результат загрузки формы. 'notfound' — единственный «нормальный» отказ: черновик,
// закрытая и несуществующая форма неотличимы (404, инвариант безопасности 5),
// поэтому один экран на все три. Прочие сбои (сеть, битое тело) — исключение,
// хук переведёт их в состояние 'error'.
export type LoadResult = { status: 'ok'; form: PublicForm } | { status: 'notfound' }

export async function fetchPublicForm(slug: string): Promise<LoadResult> {
  const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    return { status: 'notfound' }
  }
  if (!res.ok) {
    throw new Error(`форма не загрузилась: HTTP ${res.status}`)
  }
  const form = publicFormSchema.parse(await res.json())
  return { status: 'ok', form }
}
