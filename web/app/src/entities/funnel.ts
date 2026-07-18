import { z } from 'zod'

// Воронка формы (фаза 8.5 шаг 6б): на каком вопросе люди уходят. Зеркалит Go-DTO
// internal/visits/handler.go — правка одной стороны требует правки другой.
//
// Наружу приходят ТОЛЬКО счётчики: ни одного ответа респондента, как и в сводке.

export const funnelStepSchema = z.object({
  blockId: z.string(),
  label: z.string(),
  // Сколько визитов дошло до этого вопроса — включая тех, кто пошёл дальше и кто
  // отправил форму. Невозрастает по шагам.
  reached: z.number().int(),
  // Сколько остановилось именно здесь и форму НЕ отправило. Отправившие сюда не
  // входят, даже если это поле было для них последним, — иначе экран обвинял бы
  // последний вопрос, который люди как раз успешно проходят.
  droppedHere: z.number().int(),
})

export const formFunnelSchema = z.object({
  visits: z.number().int(),
  submitted: z.number().int(),
  // Ушли, не тронув ни одного вопроса. Отдельно от шагов: это не «страшный вопрос»,
  // а «форма не начата вовсе» — лечится заголовком и ожиданиями от ссылки.
  leftBeforeFirst: z.number().int(),
  steps: z.array(funnelStepSchema),
})

export type FunnelStep = z.infer<typeof funnelStepSchema>
export type FormFunnel = z.infer<typeof formFunnelSchema>
