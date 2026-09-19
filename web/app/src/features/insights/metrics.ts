import { type FormFunnel, type FunnelStep } from '../../entities/funnel'
import { formatDuration } from '../../shared/format'

// Числа и фразы аналитики, не привязанные к разметке. Отдельно от компонентов,
// чтобы их можно было проверять юнитом, не поднимая DOM.

// Доля в процентах с защитой от нулевого знаменателя: вопрос, которого никто не
// видел, дал бы NaN в ширине полоски и сломал вёрстку молча.
export function percentOf(count: number, base: number): number {
  return base > 0 ? Math.round((count / base) * 100) : 0
}

// Порог малых выборок (ADR §10, спека design/analytics-v2.md §7): при знаменателе
// меньше этого доля не показывается — остаётся число, — и такой шаг не бывает худшим.
export const MIN_BASE = 20

// Строка воронки: шаг или ступень («Открыли форму», «Отправили форму»). Одна форма
// строки на график и на выбор худшего шага, чтобы номер и подпись в пояснении
// совпадали с осью графика.
export type FunnelRow = {
  key: string
  label: string
  reached: number
  dropped: number
  // Медианы времени на странице в секундах; есть только у страниц и только когда по
  // ним есть данные.
  timeSec?: number
  leftTimeSec?: number
}

// Ключи двух ступеней воронки — не шагов формы, а её краёв. Названы константами
// потому, что по ним различается формулировка потери: на первой ступени уходят «не
// тронув ни одного вопроса», а не «остановившись здесь».
export const OPENED_KEY = 'opened'
export const SUBMITTED_KEY = 'submitted'

// Шаги воронки: страницы у многостраничной формы, вопросы — у одностраничной. Номер
// у вопроса — позиция во всей форме; у страницы номер уже в подписи («Страница 3»)
// либо его заменяет имя.
export function funnelSteps(funnel: FormFunnel): FunnelRow[] {
  if (funnel.pages.length > 0) {
    return funnel.pages.map((p) => ({
      key: `page:${p.key}`,
      label: p.label,
      reached: p.reached,
      dropped: p.droppedHere,
      ...(p.timeSamples > 0 && { timeSec: p.timeSec }),
      ...(p.leftSamples > 0 && { leftTimeSec: p.leftTimeSec }),
    }))
  }
  return funnel.steps.map((s, i) => questionRow(s, i))
}

// Воронка целиком: ступень «Открыли форму», шаги, ступень «Отправили форму».
//
// Отдельной ступени «Начали отвечать» здесь НЕТ, хотя такое число есть на карточках.
// У многостраничной формы оно совпало бы с «дошли» первой страницы — её видели все,
// кто тронул хоть один вопрос, — и воронка открывалась бы двумя строками с одним и
// тем же числом. Не начавшие показаны там, где им место: потерей первой ступени.
export function funnelRows(funnel: FormFunnel): FunnelRow[] {
  return [
    { key: OPENED_KEY, label: 'Открыли форму', reached: funnel.visits, dropped: funnel.leftBeforeFirst },
    ...funnelSteps(funnel),
    { key: SUBMITTED_KEY, label: 'Отправили форму', reached: funnel.submitted, dropped: 0 },
  ]
}

// Вопросы одной страницы многостраничной формы — с номерами во всей форме, как у
// одностраничной воронки. Вопросы страницы в steps стоят подряд (BuildFunnel).
export function pageQuestionRows(funnel: FormFunnel, pageKey: string): FunnelRow[] {
  return funnel.steps.flatMap((s, i) => (s.page === pageKey ? [questionRow(s, i)] : []))
}

function questionRow(s: FunnelStep, i: number): FunnelRow {
  return { key: s.blockId, label: `${i + 1}. ${s.label}`, reached: s.reached, dropped: s.droppedHere }
}

// Шаг, на котором уходит самая большая ДОЛЯ дошедших. Одно предложение на всю
// воронку, а не строка под каждым шагом: та повторялась бы столько раз, сколько в
// форме шагов, и настоящую потерю пришлось бы искать глазами.
//
// Доля, а не число: до первых шагов доходит больше всего людей, и по числу худшим
// почти всегда выходил бы первый вопрос. Шаг с дошедшими меньше MIN_BASE не
// участвует — «ушли 2 из 2» это не худший шаг, а два человека. При равной доле
// побеждает больший отвал, при полном равенстве — более ранний шаг.
//
// null — назвать некого: отвалов нет или все они на шагах ниже порога.
export function worstStep(steps: FunnelRow[]): (FunnelRow & { percent: number }) | null {
  let worst: FunnelRow | null = null
  for (const step of steps) {
    if (step.dropped === 0 || step.reached < MIN_BASE) continue
    if (worst === null) {
      worst = step
      continue
    }
    // Сравнение долей перекрёстным умножением: без деления нет и дробной ничьей.
    const diff = step.dropped * worst.reached - worst.dropped * step.reached
    if (diff > 0 || (diff === 0 && step.dropped > worst.dropped)) worst = step
  }
  return worst && { ...worst, percent: percentOf(worst.dropped, worst.reached) }
}

// Сколько отправили из пришедших — строкой для разбивок. Над порогом малых выборок
// это доля, ниже — два числа: «2 из 2» владелец прочтёт сам, а «100 %» он прочтёт
// как закономерность.
export function conversionText(submitted: number, visits: number): string {
  return visits >= MIN_BASE ? `${percentOf(submitted, visits)} %` : `${submitted} из ${visits}`
}

// Доля ушедших среди дошедших — только над порогом малых выборок.
export function dropPercent(row: FunnelRow): number | null {
  return row.reached >= MIN_BASE ? percentOf(row.dropped, row.reached) : null
}

// Фраза целиком, а не склонение одного слова: числительное и глагол согласуются,
// и склонять их по отдельности значит рано или поздно получить «1 остановились».
//
// Коротко («остановились здесь», а не «остановились здесь и дальше не пошли»):
// строка стоит под КАЖДЫМ шагом, а шагов у формы бывает пятнадцать. Смысл держит
// соседняя доля — «— 4 % дошедших», — и хвост из четырёх слов её только отодвигал.
export function droppedPhrase(n: number): string {
  // 1, 21, 31… — единственное число; 11 — исключение (одиннадцать остановились).
  const singular = n % 10 === 1 && n % 100 !== 11
  return singular ? `${n} остановился здесь` : `${n} остановились здесь`
}

// Потеря на первой ступени: человек открыл форму и ушёл, не тронув ни одного
// вопроса. Это не отвал на вопросе, и лечится оно другим — заголовком, длиной
// формы, ожиданиями от ссылки (docs/ANALYTICS.md, LeftBeforeFirst).
export function leftBeforeFirstPhrase(n: number): string {
  const singular = n % 10 === 1 && n % 100 !== 11
  return singular
    ? `${n} ушёл, не тронув ни одного вопроса`
    : `${n} ушли, не тронув ни одного вопроса`
}

// Строка потери под полоской шага: сколько человек здесь остановилось и какая это
// доля. null — терять было некому.
//
// Доля называется только над порогом малых выборок (dropPercent), и знаменатель у
// первой ступени другой: там «дошедшие» — это все визиты формы, и слово «дошедших»
// в первой же строке воронки читалось бы как отсылка к чему-то прежде неё.
export function lossPhrase(row: FunnelRow): string | null {
  if (row.dropped === 0) return null
  const first = row.key === OPENED_KEY
  const phrase = first ? leftBeforeFirstPhrase(row.dropped) : droppedPhrase(row.dropped)
  const pct = dropPercent(row)
  if (pct === null) return phrase
  return `${phrase} — ${pct} % ${first ? 'визитов' : 'дошедших'}`
}

// Время на шаге готовой строкой: медиана у прошедших дальше и у ушедших. Есть
// только у шагов-страниц и только когда по ним есть данные.
export function stepMeta(row: FunnelRow): string | null {
  const parts: string[] = []
  if (row.timeSec !== undefined) parts.push(`обычно проводят здесь ${formatDuration(row.timeSec)}`)
  if (row.leftTimeSec !== undefined) parts.push(`ушедшие — ${formatDuration(row.leftTimeSec)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

// Изменение к прошлому окну (спека design/analytics-v2.md §8). null — строки нет:
// прошлого окна нет или сравнивать нечестно.

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0')

// Счётчик: от порога малых выборок — в процентах, ниже — разницей: «+3» по трём
// визитам прошлой недели понятнее, чем «+100 %».
export function countDelta(current: number, previous: number | undefined): string | null {
  if (previous === undefined) return null
  if (previous < MIN_BASE) return signed(current - previous)
  return `${signed(Math.round(((current - previous) / previous) * 100))} %`
}

// Доля: разница в процентных пунктах, и только когда оба знаменателя над порогом —
// иначе сравнивались бы две случайности.
export function rateDelta(
  current: { part: number; base: number },
  previous: { part: number; base: number } | undefined,
): string | null {
  if (!previous || current.base < MIN_BASE || previous.base < MIN_BASE) return null
  const diff = Math.round((current.part / current.base) * 100 - (previous.part / previous.base) * 100)
  return `${signed(diff)} п.п.`
}

// Медиана длительности: относительное изменение, если обе медианы измерены.
export function durationDelta(
  current: { sec: number; samples: number },
  previous: { sec: number; samples: number } | undefined,
): string | null {
  if (!previous || current.samples === 0 || previous.samples === 0 || previous.sec <= 0) return null
  return `${signed(Math.round(((current.sec - previous.sec) / previous.sec) * 100))} %`
}
