import { z } from 'zod'

// Токен формы — подписанное сервером время выдачи. Его предъявляют ТРИ публичные
// ручки: приём ответа, выдача слота файла и бикон визита; каждая проверяет возраст.
//
// Приезжает отдельным некэшируемым запросом, а не в теле схемы формы (ADR §10):
// тело кэшируется на 60 секунд с иммутабельным ETag, поэтому возраст токена из него
// измерял бы возраст записи в кэше браузера, а не время, проведённое человеком на
// форме. История — JOURNAL, «Токен формы выдаётся некэшируемым ответом».
const formTokenSchema = z.object({ token: z.string() })

/**
 * Токен вместе с моментом получения.
 *
 * receivedAt снимается `performance.now()`, а не `Date.now()`: часы монотонные, и
 * перевод системного времени посреди заполнения формы не должен ни ускорить, ни
 * затормозить отправку.
 */
export interface FormToken {
  value: string
  receivedAt: number
}

export async function fetchFormToken(): Promise<FormToken> {
  const res = await fetch('/public/v1/form-token', { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`токен формы не получен: HTTP ${res.status}`)
  const body = formTokenSchema.parse(await res.json())
  return { value: body.token, receivedAt: performance.now() }
}

// minTokenAgeMs — нижняя граница возраста токена на сервере: ответ быстрее трёх
// секунд считается ботом (ARCHITECTURE §4.7). ЗЕРКАЛИТ submissions.DefaultMinFillTime
// и answerfiles: разъехавшись, эта константа не сломает сборку, а вернёт ровно тот
// отказ, ради которого написана додержка.
const minTokenAgeMs = 3000

// safetyMarginMs — запас на огрубление таймеров. Сетевая задержка играет в нашу
// пользу сама (сервер выдал токен РАНЬШЕ, чем мы его получили, и увидит его старше,
// чем намерили мы), поэтому запас нужен небольшой.
const safetyMarginMs = 300

/**
 * Додерживает вызывающего до возраста токена, который сервер примет.
 *
 * Барьер «быстрее трёх секунд — бот» задуман против скрипта, который не ждёт;
 * человек, заполнивший короткую форму за секунду, платить за него отказом не должен
 * (ADR §10). Поэтому быстрый ответ не отклоняется на клиенте и не переспрашивает
 * токен — он просто уходит чуть позже, в уже существующем состоянии «отправляем».
 *
 * МИНА: перевыпуск токена здесь был бы ровно противоположным лечением — у свежего
 * токена возраст ноль, и ждать пришлось бы всё равно, только с лишним запросом.
 */
export async function holdUntilAccepted(
  token: FormToken,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const age = performance.now() - token.receivedAt
  const remaining = minTokenAgeMs + safetyMarginMs - age
  if (remaining > 0) await sleep(remaining)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
