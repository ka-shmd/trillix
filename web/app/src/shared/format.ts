// LOCALE — язык дат и чисел кабинета. Прибит гвоздём, а не взят из браузера
// (`undefined`): интерфейс русский целиком, включая склонения, которые мы пишем
// руками, и «Aug 24, 2026» посреди русской строки выглядит сбоем, а не заботой о
// госте. Появится переключатель языка — менять здесь, в одном месте.
//
// Отсюда его берут и подписи осей графиков (features/insights/VisitsChart.tsx):
// второй `undefined` вернул бы английский на одну половину экрана.
export const LOCALE = 'ru-RU'

// Форматирование даты ISO-строки в человекочитаемый вид.
const dateFmt = new Intl.DateTimeFormat(LOCALE, {
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

// Склонение слова «просмотр» по числу: 1 просмотр, 2 просмотра, 5 просмотров.
export function pluralViews(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'просмотр'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'просмотра'
  return 'просмотров'
}

// Склонение слова «человек» по числу: 1 человек, 2 человека, 5 человек. Нужно
// плашке закрытой тарифом воронки: она называет НАСТОЯЩЕЕ число не дошедших.
export function pluralPeople(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'человека'
  return 'человек'
}

// Конверсия визитов в проценты: сколько открывших форму её отправили (фаза 8.5
// шаг 6). Считается ПО ВИЗИТАМ (submitted/total), а не делением числа ответов на
// число просмотров: ответ мог прийти без визита (бикон не дошёл, страница из кэша
// прежней версии рендерера), и частное двух независимых счётчиков конверсией не
// является (ADR §10).
//
// Ноль просмотров → null, а не 0 %: «никто не открывал» и «открывали, но никто не
// отправил» — разные новости, и рисовать их одинаково нельзя.
export function conversionPercent(submitted: number, visits: number): number | null {
  if (visits <= 0) return null
  return Math.round((submitted / visits) * 100)
}

// Секунды в человеческий вид: 8 с, 2 мин 5 с, 1 ч 4 мин. Дробные секунды не
// показываем — точность медианы визитов их не заслуживает.
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  if (total < 60) return `${total} с`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} мин ${total % 60} с`
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}
