// Double-submit CSRF: бэк кладёт токен в НЕ-httpOnly cookie при логине, клиент
// возвращает его заголовком на каждом мутирующем запросе. Cookie самой сессии —
// httpOnly, JS её не видит и не трогает (её шлёт браузер сам).
//
// Отдельный модуль, потому что потребителей два и они не могут делить транспорт:
// apiRequest ходит через fetch, а загрузка картинки — через XHR (нужен
// upload.onprogress для прогресс-бара). Пока имя cookie и имя заголовка стояли
// копией в каждом, они могли разъехаться молча — а разъехавшийся CSRF выглядит
// как «загрузка картинки внезапно даёт 403».
//
// Имя cookie зависит от контура: с флагом Secure бэк ставит `__Host-csrf_token`
// (ADR §10), в dev по http — `csrf_token`. Префиксная читается первой: cookie без
// префикса на прод-контуре может оказаться подложенной с соседнего поддомена, и её
// значение сервер не примет.
const CSRF_COOKIES = ['__Host-csrf_token', 'csrf_token']
export const CSRF_HEADER = 'X-CSRF-Token'

// readCsrfToken — токен из строки cookie. Отдельно от document, чтобы разбор
// проверялся без DOM.
export function readCsrfToken(cookie: string): string | undefined {
  const parts = cookie.split('; ')
  for (const name of CSRF_COOKIES) {
    const prefix = `${name}=`
    const part = parts.find((p) => p.startsWith(prefix))
    if (part !== undefined) return decodeURIComponent(part.slice(prefix.length))
  }
  return undefined
}

export function csrfToken(): string | undefined {
  return readCsrfToken(document.cookie)
}
