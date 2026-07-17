// Форматирование даты ISO-строки в человекочитаемый вид (локаль браузера).
const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d)
}

// Склонение слова «ответ» по числу: 1 ответ, 2 ответа, 5 ответов. Общее для страниц
// ответов и сводки — они показывают один и тот же счётчик и обязаны звучать одинаково.
export function pluralAnswers(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'ответ'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'ответа'
  return 'ответов'
}
