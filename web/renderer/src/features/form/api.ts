import { z } from 'zod'

import { formSchemaSchema } from '@entities/formSchema'

import { type Answers } from './answers'
import { bookingFactsSchema } from './slots'
import { unlockHeaders, unlockToken } from './unlock'

// Тело GET /public/v1/forms/{slug} (см. docs/API.md). schema валидируется тем же
// контрактом, что и в кабинете, — непровалидированный any внутрь не проходит
// (web/CLAUDE.md).
//
// Токена времени здесь НЕТ: ответ кэшируется (60 с + иммутабельный ETag), а токен
// обязан быть свежим — он приезжает отдельной ручкой, см. formToken.ts и ADR §10.
const publicFormSchema = z.object({
  title: z.string(),
  version: z.number().int(),
  schema: formSchemaSchema,
  // Бейдж «Сделано в Trillix» — решение СЕРВЕРА (намерение автора в схеме плюс
  // разрешение тарифа), поэтому поле, а не вывод из схемы: тариф клиенту знать
  // неоткуда. Дефолт true, а не обязательное поле: тело живёт в кеше 60 секунд, и
  // на выкатке браузер может предъявить ответ прошлой версии — падать из-за этого
  // всей формой нельзя, а бейдж по умолчанию стоит.
  showBadge: z.boolean().default(true),
  // collectPartial — сохранять ли набранное до отправки. Решение СЕРВЕРА: тумблер
  // автора плюс разрешение тарифа прямо сейчас. По этому полю рендерер делает ровно
  // две вещи — автосохраняет и предупреждает респондента; разъехаться они не могут,
  // потому что факт один. Дефолт false: не собирать по недоразумению.
  collectPartial: z.boolean().default(false),
  // progress — показывать ли шкалу прогресса (индикатор шагов). Чистое НАМЕРЕНИЕ
  // автора, живая колонка формы (миграция 0040): тарифа у шкалы нет, решать поверх
  // намерения серверу нечего. Дефолт false — тот же, что у колонки: поля нет (тело
  // прошлой версии из кеша) — значит шкалы нет. Падать из-за отсутствия поля нельзя,
  // правило то же, что у бейджа.
  progress: z.boolean().default(false),
  // Поведение формы у респондента (0044): листать страницу сразу после ответа и
  // хранить незавершённые ответы дольше вкладки. Дефолты — те же, что у колонок:
  // тело прошлой версии из кеша не имеет права включить ни то, ни другое.
  autoJump: z.boolean().default(false),
  saveLocally: z.boolean().default(false),
  // allowBack — пускать ли на пройденные страницы (0055): кнопка «Назад» и клик по
  // линии пройденного шага индикатора. Тот же дефолт и по тому же доводу — тело из
  // кеша не открывает ход назад форме, автор которой его не включал.
  allowBack: z.boolean().default(false),
  // booking — факты расписания записи (фаза 27). Поля нет — у формы нет расписания, и
  // вопрос о времени (если он в схеме) живого выбора не получит. Дефолт null, а не
  // объект из пустых строк: «записи нет» и «запись есть, но пустая» — разные вещи, и
  // второго не бывает.
  booking: bookingFactsSchema.nullable().default(null),
})
export type PublicForm = z.infer<typeof publicFormSchema>

// Тело закрытой формы (HTTP 410 Gone, фаза 8.5 шаг 4): схемы и токена нет —
// принимать нельзя. closedMessage уже разрезолвлен сервером (свой текст или дефолт).
const closedFormSchema = z.object({
  closed: z.literal(true),
  title: z.string(),
  closedMessage: z.string(),
  // Бейдж стоит и на этом экране: иначе он снимается разглядыванием второго.
  showBadge: z.boolean().default(true),
})

// Результат загрузки формы. 'notfound' — черновик и несуществующая форма (404,
// инвариант безопасности 5: приватное не раскрывается). 'closed' — форма была
// публичной, но больше не принимает ответы (410): показываем «приём закрыт» с
// текстом владельца, а не безликое «недоступна». Прочие сбои (сеть, битое тело) —
// исключение, хук переведёт их в 'error'.
export type LoadResult =
  | { status: 'ok'; form: PublicForm }
  | { status: 'closed'; title: string; message: string; showBadge: boolean }
  | { status: 'locked'; title: string; showBadge: boolean }
  | { status: 'notfound' }

// Тело формы под паролем (HTTP 401 form_locked). Схемы здесь нет — до пароля её
// видеть нечем. Название ЕСТЬ: экран ввода его показывает (решение владельца
// 2026-09-01, design/form-password.md §2.3).
const lockedFormSchema = z.object({
  locked: z.literal(true),
  title: z.string(),
  showBadge: z.boolean().default(true),
})

// preview — предпросмотр автора (`?preview=1`, макет экрана «Встроить»). Он и только
// он ходит МИМО КЭША: ответ публичной формы кэшируется на минуту, а бейдж и сбор
// черновиков — живые свойства формы (ADR §10), и автор, переключивший тумблер, обязан
// увидеть результат сейчас, а не через минуту. Респондент читает тот же ответ с
// прежним кэшем: платить временем загрузки формы за удобство автора незачем.
export async function fetchPublicForm(slug: string, preview = false): Promise<LoadResult> {
  const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json', ...unlockHeaders(slug) },
    cache: preview ? 'no-store' : 'default',
  })
  if (res.status === 404) {
    return { status: 'notfound' }
  }
  // Форма под паролем: токена нет либо он протух (сутки). Сервер уже сказал всё, что
  // можно сказать до пароля, — название и бейдж.
  if (res.status === 401) {
    const body = lockedFormSchema.parse(await res.json())
    return { status: 'locked', title: body.title, showBadge: body.showBadge }
  }
  if (res.status === 410) {
    const body = closedFormSchema.parse(await res.json())
    return {
      status: 'closed',
      title: body.title,
      message: body.closedMessage,
      showBadge: body.showBadge,
    }
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
// (подсветить поля). 'closed' — форма больше не принимает ответы: 410 (закрыта:
// снята/дата/лимит) или 404 (исчезла). 'rejected' — прочий осмысленный отказ сервера
// (антиспам-422 без полей, 413, 429): показываем сообщение, но поля ни при чём.
// Сетевой обрыв — исключение (throw), ретраит вызывающий.
export type SubmitOutcome =
  | { status: 'ok' }
  | { status: 'invalid'; fields: Record<string, string> }
  | { status: 'closed' }
  | { status: 'rejected'; message: string }

export interface SubmitBody {
  submissionId: string
  token: string
  answers: Answers
  /** Визит, из которого пришёл ответ (фаза 8.5 шаг 6) — отсюда точная конверсия. */
  visitId: string
}

export async function submitAnswers(slug: string, body: SubmitBody): Promise<SubmitOutcome> {
  const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...unlockHeaders(slug) },
    body: JSON.stringify({
      submission_id: body.submissionId,
      token: body.token,
      answers: body.answers,
      website: '', // honeypot: у настоящего респондента всегда пусто
      visit_id: body.visitId,
    }),
  })
  if (res.status === 201) return { status: 'ok' }
  // Форма заперлась под нами: автор поставил пароль, пока её заполняли, либо истёк
  // токен разблокировки. Перезагрузка покажет экран ввода пароля — набранное при
  // этом останется в браузере (черновик).
  if (res.status === 401) {
    return { status: 'rejected', message: 'Форма закрыта паролем — обновите страницу и введите его.' }
  }
  // 410 — форма закрылась (снята/дата/лимит); 404 — исчезла. И то, и другое →
  // принимать больше нельзя, показываем «приём закрыт».
  if (res.status === 410 || res.status === 404) return { status: 'closed' }

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
  // 5xx — сбой на нашей стороне, а не осмысленный отказ респонденту: его текст
  // служебный (respond.go шлёт обезличенное «internal server error», причина уходит
  // в лог с request_id). Респонденту показываем человеческое — читать внутренности
  // сервера он не должен. У 4xx текст осмысленный (антиспам, лимит) — он и едет.
  if (res.status >= 500) {
    return {
      status: 'rejected',
      message: 'Не удалось отправить — попробуйте ещё раз через минуту.',
    }
  }
  return { status: 'rejected', message: env.error.message }
}

// savePartial отправляет черновик — то, что человек набрал и пока не отправил.
//
// keepalive, а не sendBeacon, у обычного сохранения: тело JSON и заголовок нам
// нужны, а bearer-семантики нет. На уходе со страницы вызывающий шлёт то же самое
// через sendBeacon — он переживает закрытие вкладки, где fetch уже отменяется.
//
// Ошибки ГЛОТАЮТСЯ намеренно: автосохранение — фон, и респондент не должен ни
// видеть его сбой, ни спотыкаться о него при отправке настоящего ответа.
export function savePartial(slug: string, body: PartialBody): void {
  const payload = JSON.stringify(withUnlock(slug, body))
  void fetch(`/public/v1/forms/${encodeURIComponent(slug)}/partial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {})
}

// savePartialOnLeave — последнее сохранение на уходе со страницы. sendBeacon
// переживает закрытие вкладки; Blob задаёт Content-Type (заголовки этому API не
// передать).
export function savePartialOnLeave(slug: string, body: PartialBody): void {
  const blob = new Blob([JSON.stringify(withUnlock(slug, body))], { type: 'application/json' })
  navigator.sendBeacon(`/public/v1/forms/${encodeURIComponent(slug)}/partial`, blob)
}

export interface PartialBody {
  visit_id: string
  token: string
  version: number
  answers: Answers
  last_block_id: string | null
}

// withUnlock дописывает токен разблокировки В ТЕЛО — у этой ручки он едет так, а не
// заголовком, как у остальных трёх: последнее сохранение уходит через sendBeacon, а
// он заголовков не умеет вовсе (design/form-password.md §3.4). Оба пути одной ручки
// шлют одинаково, чтобы у неё не было двух правил.
function withUnlock(slug: string, body: PartialBody): PartialBody & { unlock: string } {
  return { ...body, unlock: unlockToken(slug) }
}
