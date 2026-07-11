import { z } from 'zod'

// Единственный источник типа пользователя: Zod-схема, TS-тип выводится из неё
// (web/CLAUDE.md — руками интерфейсы не дублируем). Форма ответа /auth/*.
export const userSchema = z.object({
  id: z.string(),
  email: z.email(),
})

export type User = z.infer<typeof userSchema>
