import { z } from 'zod'

// Единственный источник типа пространства — Zod-схема (web/CLAUDE.md). Форма
// ответа GET /workspaces. Личное создаётся регистрацией и всегда первое в списке.
export const workspaceSchema = z.object({
  id: z.string(),
  // slug — короткий публичный ключ (nanoid(10)): им кабинет адресует пространство
  // в СВОИХ URL (/workspaces/{slug}, ?w={slug}), как формой — form.slug. В запросы
  // API едет id — ровно то же разделение, что у формы.
  slug: z.string(),
  name: z.string(),
  // isPersonal — личное пространство: его нельзя удалить или покинуть, и оно не
  // замораживается при даунгрейде (ADR §10).
  isPersonal: z.boolean(),
  // formCount — сколько форм в пространстве (подпись рядом с названием в обзоре).
  // Точен на СПИСКЕ; у ответов мутаций всегда 0 — они отвечают самой вывеской,
  // а число приезжает перечитанным списком.
  formCount: z.number().int(),
})

export type Workspace = z.infer<typeof workspaceSchema>

// Потолок имени пространства в рунах — зеркалит workspaces.MaxNameLen (Go).
// Расходиться им нельзя: поле, дающее набрать больше, чем примет сервер, врёт.
export const MAX_WORKSPACE_NAME_LEN = 60

// Ответ списка воркспейсов пользователя (парсится на границе API).
export const workspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSchema),
})
