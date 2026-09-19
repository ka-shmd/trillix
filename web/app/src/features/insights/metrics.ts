import { type FormFunnel, type FunnelStep } from '../../entities/funnel'

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
export function funnelRows(funnel: FormFunnel): FunnelRow[] {
  return [
    { key: 'opened', label: 'Открыли форму', reached: funnel.visits, dropped: funnel.leftBeforeFirst },
    ...funnelSteps(funnel),
    { key: 'submitted', label: 'Отправили форму', reached: funnel.submitted, dropped: 0 },
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

// Доля ушедших среди дошедших — только над порогом малых выборок.
export function dropPercent(row: FunnelRow): number | null {
  return row.reached >= MIN_BASE ? percentOf(row.dropped, row.reached) : null
}

// Фраза целиком, а не склонение одного слова: в ней согласуются ДВА глагола
// («остановился … не пошёл» против «остановились … не пошли»), и склонять их по
// отдельности значит рано или поздно получить «1 остановился и дальше не пошли».
export function droppedPhrase(n: number): string {
  // 1, 21, 31… — единственное число; 11 — исключение (одиннадцать остановились).
  const singular = n % 10 === 1 && n % 100 !== 11
  return singular
    ? `${n} остановился здесь и дальше не пошёл`
    : `${n} остановились здесь и дальше не пошли`
}
