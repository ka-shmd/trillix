import { z } from 'zod'

import { formSchemaSchema } from '@entities/formSchema'

import { type Answers } from './answers'

// Тело GET /public/v1/forms/{slug} (см. docs/API.md). schema валидируется тем же
// контрактом, что и в кабинете, — непровалидированный any внутрь не проходит
// (web/CLAUDE.md). token — подписанное время выдачи (антиспам фазы 5), пока
// просто хранится для будущей отправки.
const publicFormSchema = z.object({
  title: z.string(),
  version: z.number().int(),
  schema: formSchemaSchema,
  token: z.string(),
})
export type PublicForm = z.infer<typeof publicFormSchema>

// Результат загрузки формы. 'notfound' — единственный «нормальный» отказ: черновик,
// закрытая и несуществующая форма неотличимы (404, инвариант безопасности 5),
// поэтому один экран на все три. Прочие сбои (сеть, битое тело) — исключение,
// хук переведёт их в состояние 'error'.
export type LoadResult = { status: 'ok'; form: PublicForm } | { status: 'notfound' }

export async function fetchPublicForm(slug: string): Promise<LoadResult> {
  const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    return { status: 'notfound' }
  }
  if (!res.ok) {
    throw new Error(`форма не загрузилась: HTTP ${res.status}`)
  }
  const form = publicFormSchema.parse(await res.json())
  return { status: 'ok', form }
}

// Конверт ошибки API (docs/API.md): fields — карта block_id → сообщение (только у
// валидации ответа). Разбираем через Zod: непровалидированный any внутрь не проходит.
const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
})

// Итог отправки. 'ok' — принято (201). 'invalid' — 422 с пофайловыми ошибками
// (подсветить поля). 'closed' — форма больше не принимает ответы (404). 'rejected' —
// прочий осмысленный отказ сервера (антиспам-422 без полей, 413, 429): показываем
// сообщение, но поля ни при чём. Сетевой обрыв — исключение (throw), ретраит вызывающий.
export type SubmitOutcome =
  | { status: 'ok' }
  | { status: 'invalid'; fields: Record<string, string> }
  | { status: 'closed' }
  | { status: 'rejected'; message: string }

export interface SubmitBody {
  submissionId: string
  token: string
  answers: Answers
}

export async function submitAnswers(slug: string, body: SubmitBody): Promise<SubmitOutcome> {
  const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      submission_id: body.submissionId,
      token: body.token,
      answers: body.answers,
      website: '', // honeypot: у настоящего респондента всегда пусто
    }),
  })
  if (res.status === 201) return { status: 'ok' }
  if (res.status === 404) return { status: 'closed' }

  // Прочие не-2xx: разбираем конверт. Не распарсился (не наш формат) — сеть/прокси
  // отдали что-то чужое: это исключение, вызывающий переведёт в состояние ошибки.
  let env
  try {
    env = errorEnvelopeSchema.parse(await res.json())
  } catch {
    throw new Error(`отправка не удалась: HTTP ${res.status}`)
  }
  const fields = env.error.fields
  if (res.status === 422 && fields && Object.keys(fields).length > 0) {
    return { status: 'invalid', fields }
  }
  return { status: 'rejected', message: env.error.message }
}
