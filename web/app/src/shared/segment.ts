// Разрез визитов (спека design/analytics-v2.md §5.4, analytics-v3.md §11.6): условие
// «измерение:значение» — «только телефоны», «только из vk.com», «только версия 3».
// Условий бывает несколько, и они складываются через «И»: «телефоны из vk.com».
//
// Живёт в shared, а не в фиче: разрез читают запросы воронки и запросы карточек, а
// это разные фичи. И в адресе, и в запросе условие — строка «измерение:значение»;
// разбирает и проверяет её сервер (domain.ParseSegment), набор измерений зеркалит
// segmentDims там.

export const segmentDimLabels = {
  device: 'Устройство',
  browser: 'Браузер',
  os: 'Система',
  source: 'Источник',
  country: 'Страна',
  city: 'Город',
  version: 'Версия формы',
} as const

export type SegmentDim = keyof typeof segmentDimLabels

export function isSegmentDim(s: string): s is SegmentDim {
  return Object.hasOwn(segmentDimLabels, s)
}

// MAX_SEGMENTS — зеркалит domain.MaxSegments: больше условий сервер не примет.
export const MAX_SEGMENTS = 7

// Условия разреза из адреса. Одно условие лежит строкой, несколько — массивом
// (роутер сериализует массив в JSON, строку оставляет как есть), поэтому читать надо
// оба вида. Смысл значения проверяет сервер; кривое даст 422 и экран ошибки.
export function segmentsFromSearch(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw]
  return list.filter((v): v is string => typeof v === 'string' && v !== '').slice(0, MAX_SEGMENTS)
}

// Обратно в адрес. ОДНО условие уезжает СТРОКОЙ, а не массивом из одного элемента:
// массив роутер пишет как JSON, и обычная ссылка «посмотри на это» превращалась бы в
// `?segment=%5B%22device%3A...%22%5D` там, где сегодня читается «device:Телефон».
export function segmentsToSearch(list: string[]): string | string[] | undefined {
  if (list.length === 0) return undefined
  return list.length === 1 ? list[0] : list
}

// Условие, добавленное к уже выбранным. Условие на ИЗМЕРЕНИЕ одно: «устройство —
// телефон И устройство — планшет» не сужает выборку, а обнуляет её. Поэтому второе
// значение того же измерения заменяет первое, а то же самое — снимает. Правило то
// же, что у условий по ответам (shared/answerFilter.ts, withCondition).
export function withSegment(list: string[], dim: SegmentDim, value: string): string[] {
  const next = `${dim}:${value}`
  if (list.includes(next)) return list.filter((s) => s !== next)
  const rest = list.filter((s) => splitSegment(s)?.dim !== dim)
  if (rest.length === list.length && list.length >= MAX_SEGMENTS) return list
  return [...rest, next]
}

export function splitSegment(segment: string | undefined): { dim: SegmentDim; value: string } | null {
  if (!segment) return null
  const i = segment.indexOf(':')
  const dim = segment.slice(0, i)
  if (i < 0 || !isSegmentDim(dim)) return null
  return { dim, value: segment.slice(i + 1) }
}

// Условия в параметры запроса: `segment` ПОВТОРЯЕТСЯ (domain.ParseSegments читает
// r.URL.Query()["segment"]). Повторяющийся параметр, а не список в одной строке:
// значения приходят из меток визита и содержат что угодно, включая любой
// разделитель, который пришлось бы выдумать.
export function appendSegments(params: URLSearchParams, segments: string[] = []): URLSearchParams {
  for (const s of segments) params.append('segment', s)
  return params
}

// Порог малых выборок — ЗЕРКАЛИТ domain.SegmentK. В ответе API числа нет (`withheld`
// булево), поэтому копия порога живёт здесь: три экрана объясняют человеку, почему
// распределения, таблица и сами ответы не показаны, и обязаны называть то же число,
// по которому сервер их скрыл.
export const SEGMENT_K = 5
