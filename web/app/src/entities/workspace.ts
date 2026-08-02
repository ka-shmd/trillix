import { z } from 'zod'

// Единственный источник типа пространства — Zod-схема (web/CLAUDE.md). Форма
// ответа GET /workspaces. Личное создаётся регистрацией и всегда первое в списке.
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  // isPersonal — личное пространство: его нельзя удалить или покинуть, и оно не
  // замораживается при даунгрейде (ADR §10).
  isPersonal: z.boolean(),
})

export type Workspace = z.infer<typeof workspaceSchema>

// Ответ списка воркспейсов пользователя (парсится на границе API).
export const workspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSchema),
})
