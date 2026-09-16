import { type HostBridge } from './embed'

// Цели Яндекс Метрики автора (фаза 29 DEV-PLAN, спека design/yandex-metrika.md §6–§7).
// Номер решает сервер (поле `metrika` публичной отдачи: подключён, включён, тариф
// разрешает) — здесь только куда уходят три цели.
//
// Ответы в Метрику не уходят ни в каком виде: цель — одно имя, без параметров цели и
// параметров визита. Метки рекламы (yclid, UTM) счётчик читает из адреса сам.

/** Цели, которые автор заводит в Метрике как «JavaScript-событие». Имена — контракт с его счётчиком. */
export const GOAL_OPEN = 'trillix_open'
export const GOAL_START = 'trillix_start'
export const GOAL_SUBMIT = 'trillix_submit'
export type Goal = typeof GOAL_OPEN | typeof GOAL_START | typeof GOAL_SUBMIT

export const TAG_SRC = 'https://mc.yandex.ru/metrika/tag.js'

/** Функция `ym` стандартного кода счётчика: до загрузки `tag.js` — очередь вызовов. */
type Ym = ((...args: unknown[]) => void) & { a?: unknown[][]; l?: number }

export interface MetrikaHost {
  /** Глобал страницы, куда ставится `ym` (в бою — window). */
  win: { ym?: Ym }
  /** Добавить на страницу внешний скрипт. Элементом, а не инлайном: `script-src` без 'unsafe-inline'. */
  appendScript(src: string): void
}

export interface GoalSink {
  /** Отметить цель. Каждая уходит не больше одного раза за визит. */
  reach(goal: Goal): void
}

/**
 * goalSink — куда уходят цели формы; null — никуда.
 *
 * - Предпросмотр автора визитов не считает — и целей не отмечает.
 * - Обычная страница — собственный счётчик автора (`startMetrika`).
 * - Фрейм со встроенной формой — сообщение хосту через мост, а счётчик СТРАНИЦЫ отмечает
 *   цель сам. Свой счётчик во фрейме не грузится ни при каком раскладе: сторонний
 *   контекст режет cookie Метрики, а со счётчиком сайта вышел бы двойной счёт (§7).
 * - Фрейм без моста (голый `<iframe>`, ссылка в Notion) — никуда: принимать некому.
 */
export function goalSink(
  counter: string | null,
  env: { preview: boolean; framed: boolean; bridge: HostBridge | null },
  host: MetrikaHost,
): GoalSink | null {
  if (counter === null || env.preview) return null
  if (env.framed) {
    const { bridge } = env
    if (bridge === null) return null
    // Номер числом: так его ждёт `ym`. Двенадцать цифр (CHECK в form_counters) точны в double.
    const id = Number(counter)
    return onceEach((goal) => bridge.goal(id, goal))
  }
  return startMetrika(counter, host)
}

/**
 * startMetrika — стандартный код счётчика без инлайн-скрипта: очередь `ym`, элемент
 * `<script async>` и `init`. Вебвизор выключен ЯВНО — умолчание Метрики тоже `false`,
 * но решение владельца не должно зависеть от смены чужого умолчания.
 */
export function startMetrika(counter: string, host: MetrikaHost): GoalSink {
  const { win } = host
  if (win.ym === undefined) {
    const ym: Ym = (...args) => {
      ;(ym.a ??= []).push(args)
    }
    ym.l = Date.now()
    win.ym = ym
    host.appendScript(TAG_SRC)
  }
  const id = Number(counter)
  win.ym!(id, 'init', {
    webvisor: false,
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
  })
  return onceEach((goal) => win.ym!(id, 'reachGoal', goal))
}

function onceEach(send: (goal: Goal) => void): GoalSink {
  const reached = new Set<Goal>()
  return {
    reach(goal) {
      if (reached.has(goal)) return
      reached.add(goal)
      send(goal)
    },
  }
}

/** browserHost — MetrikaHost поверх настоящей страницы. Сам ничего не делает до вызова. */
export function browserHost(): MetrikaHost {
  return {
    win: window as unknown as { ym?: Ym },
    appendScript(src) {
      const script = document.createElement('script')
      script.async = true
      script.src = src
      document.head.appendChild(script)
    },
  }
}
