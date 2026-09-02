import { z } from 'zod'

import { formSchemaSchema, type FormSchema } from '@entities/formSchema'
import { apiRequest } from '../../../shared/api/client'

// Разговор с ассистентом над формой (фаза 26, слайс E).
//
// Документ едет В ОБЕ СТОРОНЫ, но сервер его не сохраняет: правится то, что автор
// видит сейчас (полотно бывает свежее сохранённого), а в базу документ уносит
// автосейв своим путём. Поэтому здесь нет ни инвалидации кэша, ни оптимистичной
// блокировки — их держит автосейв.

// MAX_CHAT_MESSAGE_LEN — зеркало forms.MaxChatMessageLen; бэк проверяет длину сам.
export const MAX_CHAT_MESSAGE_LEN = 1000

// MAX_CHAT_HISTORY — сколько прошлых реплик отправляем. Зеркало
// forms.MaxChatHistory: сервер всё равно возьмёт последние столько же, но возить
// лишнее по сети незачем.
export const MAX_CHAT_HISTORY = 10

export type ChatRole = 'user' | 'assistant'

export interface ChatTurn {
  role: ChatRole
  text: string
  // plan — реплика ассистента, в которой часть просьбы не сделана из-за тарифа.
  // Живёт на реплике, а не в состоянии экрана: разговор идёт дальше, и предложение
  // тарифа обязано остаться у той реплики, к которой относится.
  plan?: boolean
}

// Схема ответа: `schema` приходит, ТОЛЬКО если правка состоялась; `planRequired` —
// часть просьбы не выполнена из-за тарифа (решает сервер, а не разбор слов ответа).
const chatReplySchema = z.object({
  reply: z.string(),
  schema: formSchemaSchema.optional(),
  planRequired: z.boolean().optional(),
})

export type ChatReply = z.infer<typeof chatReplySchema>

export function sendChatMessage(
  formId: string,
  message: string,
  history: ChatTurn[],
  schema: FormSchema,
): Promise<ChatReply> {
  return apiRequest(`/forms/${formId}/ai/chat`, {
    method: 'POST',
    // История едет БЕЗ своих пометок: сервер разбирает тело строго (лишнее поле —
    // 422), а `plan` — знание кабинета о собственной ленте, модели оно не нужно.
    body: {
      message,
      history: history.slice(-MAX_CHAT_HISTORY).map((t) => ({ role: t.role, text: t.text })),
      schema,
    },
    schema: chatReplySchema,
  })
}
