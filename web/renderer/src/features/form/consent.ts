// Согласие на обработку персональных данных под кнопкой отправки (design/privacy-consent.md).

export type ConsentDocKind = 'consent' | 'policy'

// Путь страницы документа. Один и тот же здесь и в main.tsx — там он разбирается
// обратно; разъехавшись, ссылка вела бы на форму «недоступна».
export const DOCUMENTS_PATH = '/documents/'

// documentHref — адрес страницы документа ревизии. Версия формы в адресе обязательна:
// перечень данных в типовом тексте — вопросы ТОЙ версии, которую человек заполняет, а
// не той, что станет текущей, пока он читает документ.
export function documentHref(slug: string, kind: ConsentDocKind, revision: string, version: number): string {
  const q = new URLSearchParams({ revision, version: String(version) })
  return `${DOCUMENTS_PATH}${encodeURIComponent(slug)}/${kind}?${q.toString()}`
}

// documentFromPath — slug и вид документа из пути страницы; null — путь не наш.
export function documentFromPath(pathname: string): { slug: string; kind: ConsentDocKind } | null {
  const m = pathname.match(/^\/documents\/([^/]+)\/(consent|policy)\/?$/)
  if (!m) return null
  return { slug: decodeURIComponent(m[1] ?? ''), kind: m[2] as ConsentDocKind }
}
