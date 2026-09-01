import { z } from 'zod'

// Разблокировка формы, закрытой паролем (docs/design/form-password.md).
//
// Токен живёт в sessionStorage — «на вкладку» (решение владельца 2026-09-01, §2.4):
// перезагрузка страницы пароль не спрашивает, новая вкладка или окно — спрашивает.
// На общем компьютере разблокировка не переживает закрытия вкладки.
//
// НЕ cookie: встроенная в чужой сайт форма (EMBED.md) — третья сторона, и её cookie
// браузеры режут. Заголовок плюс своё хранилище работают и во фрейме.
//
// Хранилище держит ЭТОТ модуль, а не вызывающий: токен нужен четырём запросам
// (форма, ответ, черновик, слот файла), и протаскивать его через все параметры
// значило бы четыре шанса забыть — то есть тихую дыру вместо пароля.

const storageKey = (slug: string) => `trillix-unlock:${slug}`

// Запасная память на случай, когда sessionStorage недоступен: приватный режим,
// запрет хранения третьей стороне у встроенной формы. Живёт до перезагрузки страницы
// и ровно этим отличается от штатного пути — пароль спросят снова после F5.
//
// МИНА: без неё разблокировка в таком браузере не работает ВОВСЕ, а не «работает
// хуже»: верный пароль принимается, токен молча теряется, форма снова просит пароль.
const memory = new Map<string, string>()

/**
 * Токен разблокировки этой формы, если он есть в этой вкладке.
 *
 * sessionStorage доступен не всегда (приватный режим, запрет на хранение у
 * встроенного фрейма) — тогда пароль просто спросят ещё раз, и это лучше, чем
 * исключение посреди загрузки формы.
 */
export function unlockToken(slug: string): string {
  try {
    const stored = sessionStorage.getItem(storageKey(slug))
    if (stored !== null) return stored
  } catch {
    // Хранилище недоступно — читаем из запасной памяти ниже.
  }
  return memory.get(slug) ?? ''
}

export function rememberUnlock(slug: string, token: string): void {
  // В память кладём ВСЕГДА, а не только в ветке отказа: одна дорога чтения на два
  // хранилища дешевле, чем ветка «где искать», и делает отказ storage незаметным.
  memory.set(slug, token)
  try {
    sessionStorage.setItem(storageKey(slug), token)
  } catch {
    // Хранить негде: разблокировка живёт до перезагрузки страницы, а не до закрытия
    // вкладки. Это единственная разница, и она лучше, чем форма, которую в таком
    // браузере нельзя открыть вовсе.
  }
}

/**
 * Заголовок разблокировки для запроса. Пустой токен даёт пустой объект — у формы
 * без пароля запрос не меняется ни на байт.
 *
 * ⚠ МИНА: заголовок обязан ехать со ВСЕМИ публичными запросами по slug, кроме
 * автосохранения черновика — там токен едет в теле, потому что последнее сохранение
 * уходит через sendBeacon, а он заголовков не умеет.
 */
export function unlockHeaders(slug: string): Record<string, string> {
  const token = unlockToken(slug)
  return token === '' ? {} : { 'X-Form-Unlock': token }
}

const unlockResponseSchema = z.object({ token: z.string() })

/** Итог попытки: 'ok' — токен получен, 'wrong' — пароль не подошёл, 'limited' —
 *  попытки исчерпаны (ведро по паре «адрес + форма» на сервере). */
export type UnlockOutcome = { status: 'ok' } | { status: 'wrong' } | { status: 'limited' }

/**
 * Называет пароль и запоминает выданный токен.
 *
 * Неверный пароль и форма, у которой пароля нет, отвечают одинаково (401): различать
 * их на экране нечем и незачем — подбирающему подсказка, человеку шум.
 */
export async function unlockForm(slug: string, password: string): Promise<UnlockOutcome> {
  const res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (res.status === 429) return { status: 'limited' }
  if (!res.ok) return { status: 'wrong' }
  const body = unlockResponseSchema.parse(await res.json())
  rememberUnlock(slug, body.token)
  return { status: 'ok' }
}
