import { createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'

import { LegalDocumentPage } from '../features/legal/LegalPages'
import { consentKindSchema } from '../entities/legal'

// Документ сервиса — действующая редакция или прежняя по ?version= (дата редакции). Без
// входа, как и оглавление. Неизвестный вид документа — 404 роутера: такой страницы нет.
const documentSearchSchema = z.object({
  version: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/legal/$kind')({
  validateSearch: documentSearchSchema,
  beforeLoad: ({ params }) => {
    if (!consentKindSchema.safeParse(params.kind).success) throw notFound()
  },
  component: DocumentRoute,
})

function DocumentRoute() {
  const { kind } = Route.useParams()
  const { version } = Route.useSearch()
  return <LegalDocumentPage kind={consentKindSchema.parse(kind)} version={version ?? ''} />
}
