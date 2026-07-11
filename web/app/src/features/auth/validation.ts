import { z } from 'zod'

// Клиентская валидация дублирует серверную (bounds из internal/auth/service.go:
// email — валидный, пароль 8–128). Она — про UX; истина всё равно на бэке.
export const credentialsSchema = z.object({
  email: z.email({ message: 'Введите корректный email' }),
  password: z
    .string()
    .min(8, { message: 'Пароль — минимум 8 символов' })
    .max(128, { message: 'Пароль — максимум 128 символов' }),
})

export type Credentials = z.infer<typeof credentialsSchema>
