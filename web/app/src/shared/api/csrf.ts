// Double-submit CSRF: бэк кладёт токен в НЕ-httpOnly cookie при логине, клиент
// возвращает его заголовком на каждом мутирующем запросе. Cookie самой сессии —
// httpOnly, JS её не видит и не трогает (её шлёт браузер сам).
//
// Отдельный модуль, потому что потребителей два и они не могут делить транспорт:
// apiRequest ходит через fetch, а загрузка картинки — через XHR (нужен
// upload.onprogress для прогресс-бара). Пока имя cookie и имя заголовка стояли
// копией в каждом, они могли разъехаться молча — а разъехавшийся CSRF выглядит
// как «загрузка картинки внезапно даёт 403».
const CSRF_COOKIE = 'csrf_token'
export const CSRF_HEADER = 'X-CSRF-Token'

export function csrfToken(): string | undefined {
  const prefix = `${CSRF_COOKIE}=`
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length))
  }
  return undefined
}
