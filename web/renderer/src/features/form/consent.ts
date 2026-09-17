// Согласие на обработку персональных данных под кнопкой отправки (design/privacy-consent.md).

export type ConsentDocKind = 'consent' | 'policy'

// Путь страницы документа. Один и тот же здесь и в main.tsx — там он разбирается
// обратно; разъехавшись, ссылка вела бы на форму «недоступна».
export const DOCUMENTS_PATH = '/documents/'

// documentHref — адрес страницы документа ревизии. Версии формы в адресе нет: перечень
// данных сервер собирает по текущей опубликованной, старую публично не отдаёт.
export function documentHref(slug: string, kind: ConsentDocKind, revision: string): string {
  const q = new URLSearchParams({ revision })
  return `${DOCUMENTS_PATH}${encodeURIComponent(slug)}/${kind}?${q.toString()}`
}

// consentToSend — ревизия, которая уходит с ответом. Только при отмеченной галочке: сервер
// принимает присланную ревизию как согласие человека, и отправленная без галочки стала бы
// согласием, которого он не давал.
export function consentToSend(revision: string | null, checked: boolean): string {
  return revision !== null && checked ? revision : ''
}

// documentFromPath — slug и вид документа из пути страницы; null — путь не наш.
export function documentFromPath(pathname: string): { slug: string; kind: ConsentDocKind } | null {
  const m = pathname.match(/^\/documents\/([^/]+)\/(consent|policy)\/?$/)
  if (!m) return null
  return { slug: decodeURIComponent(m[1] ?? ''), kind: m[2] as ConsentDocKind }
}
