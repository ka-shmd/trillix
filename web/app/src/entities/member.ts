import { z } from 'zod'

// Единственный источник типов состава пространства — Zod-схемы (web/CLAUDE.md).
// Форма ответа GET /workspaces/{id}/members.

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  // Профиль коллеги — для кружка в списке: картинка или инициалы (initials в
  // entities/user.ts). Пустые строки = не заполнено, как и в профиле своего
  // аккаунта: сервер сводит NULL к строке на границе.
  firstName: z.string(),
  lastName: z.string(),
  avatarKey: z.string(),
  role: z.string(),
  joinedAt: z.string(),
})

export const pendingInviteSchema = z.object({
  email: z.string(),
  role: z.string(),
  expiresAt: z.string(),
})

// permissions — что может СПРАШИВАЮЩИЙ. Кабинет прячет по нему кнопки и не
// повторяет матрицу прав в TypeScript: она живёт на сервере в одном месте.
export const membersResponseSchema = z.object({
  members: z.array(memberSchema),
  invites: z.array(pendingInviteSchema),
  permissions: z.array(z.string()),
})

export type Member = z.infer<typeof memberSchema>
export type PendingInvite = z.infer<typeof pendingInviteSchema>
export type MembersState = z.infer<typeof membersResponseSchema>

// Приглашение глазами позванного (GET /invitations/{token}). id пространства и
// состав участников сюда не входят: пока приглашение не принято, он посторонний.
export const invitationSchema = z.object({
  workspaceName: z.string(),
  email: z.string(),
  role: z.string(),
  state: z.enum(['usable', 'used', 'expired']),
})

export type Invitation = z.infer<typeof invitationSchema>
