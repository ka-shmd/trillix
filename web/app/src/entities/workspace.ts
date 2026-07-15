import { z } from 'zod'

// Единственный источник типа воркспейса — Zod-схема (web/CLAUDE.md). Форма ответа
// GET /workspaces. В MVP у пользователя один личный воркспейс («Personal»).
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export type Workspace = z.infer<typeof workspaceSchema>

// Ответ списка воркспейсов пользователя (парсится на границе API).
export const workspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSchema),
})
