import { z } from 'zod'

// Единственный источник типа пользователя: Zod-схема, TS-тип выводится из неё
// (web/CLAUDE.md — руками интерфейсы не дублируем). Форма ответа /auth/*.
export const userSchema = z.object({
  id: z.string(),
  email: z.email(),
  // Подтверждён ли email (слайс C): по нему кабинет рисует баннер «подтвердите
  // почту». Приезжает во всех ответах /auth/* (register/login/me/link).
  emailVerified: z.boolean(),
})

export type User = z.infer<typeof userSchema>
