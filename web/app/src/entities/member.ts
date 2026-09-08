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

// permissions — что может СПРАШИВАЮЩИЙ. Кабинет прячет по нему кнопки и не
// повторяет матрицу прав в TypeScript: она живёт на сервере в одном месте.
//
// Списка «позвали, но ещё не вошёл» здесь нет и быть не может: ссылка никого не
// называет, поэтому между её выпиской и входом человека продукт про него ничего
// не знает (ADR §10). Состояние приглашения одно — сама ссылка, и она приезжает
// своей ручкой.
export const membersResponseSchema = z.object({
  members: z.array(memberSchema),
  permissions: z.array(z.string()),
})

export type Member = z.infer<typeof memberSchema>
export type MembersState = z.infer<typeof membersResponseSchema>

// Ссылка-приглашение глазами ВЛАДЕЛЬЦА (GET/POST /workspaces/{id}/join-link).
// Токен приезжает целиком внутри url — в базе он лежит сырым (ADR §10), и это
// единственное такое место в продукте.
export const joinLinkSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  // expired — срок вышел. Отдельным полем, а не отсутствием ссылки: «истекла,
  // создайте новую» и «ссылки нет» — разные новости для человека.
  expired: z.boolean(),
})

// link: null — живой ссылки у пространства нет. Это не отказ: её может не быть
// никогда, и отличать этот случай от «пространства нет» кабинету необходимо.
export const joinLinkResponseSchema = z.object({
  link: joinLinkSchema.nullable(),
})

export type JoinLink = z.infer<typeof joinLinkSchema>

// Ссылка глазами ЗОВОМОГО (GET /join/{token}): куда зовут и кем он станет. Ни id
// пространства, ни состава — пока он не вошёл, он посторонний.
export const joinPreviewSchema = z.object({
  workspaceName: z.string(),
  role: z.string(),
})

export type JoinPreview = z.infer<typeof joinPreviewSchema>
