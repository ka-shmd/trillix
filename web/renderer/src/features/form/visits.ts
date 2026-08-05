import { uuidv7 } from './submissionId'

// Визит публичной формы (фаза 8.5 шаг 6): знаменатель к числу ответов и фундамент
// воронки. Считает клиент биконами, а не сервер на выдаче формы — серверный счёт
// занижен кэшем GET формы и не может сказать, докуда дошёл ушедший (ADR §10).
//
// Ни cookie, ни localStorage: id визита живёт в памяти страницы и умирает с ней,
// поэтому человек между визитами не узнаётся — это часть контракта, а не недоделка.

// Метки источника берём из адреса страницы. Список закрытый — тот же, что на сервере;
// произвольные параметры в аналитику не уезжают.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const

function readUTM(search: string): Record<string, string> {
  const params = new URLSearchParams(search)
  const utm: Record<string, string> = {}
  for (const key of UTM_KEYS) {
    const value = params.get(key)
    if (value) utm[key] = value
  }
  return utm
}

export interface VisitTracker {
  /** id визита — уезжает с ответом, отсюда точная конверсия. */
  readonly id: string
  /** Бикон «открыли»: визит появляется в момент показа формы. */
  start(): void
  /** Бикон «дошёл до вопроса»: самая дальняя точка на момент ухода со страницы. */
  leave(lastBlockId: string | null): void
  /**
   * Бикон «перешёл на страницу» (фаза 19): первый вопрос открывшейся страницы.
   *
   * Тот же payload и та же ручка, что у leave, — разные только повод и имя. Именно
   * этого уточнения ждала воронка с самого начала (ADR §10, SCHEMA.md): переход на
   * страницу — НАБЛЮДАЕМОЕ событие, в отличие от «коснулся поля», которое молчит про
   * проскроллившего и передумавшего. Сервер по-прежнему берёт максимальный seq, поэтому
   * порядок доставки не важен, а «назад» дальнюю точку не откатывает — за этим следит
   * вызывающий.
   */
  reach(blockId: string): void
}

// createVisitTracker — состояние одного визита. seq растёт с каждым биконом:
// sendBeacon не гарантирует порядок доставки, а visibilitychange срабатывает на
// каждое переключение вкладки, поэтому «докуда дошёл» сервер выбирает по номеру, а
// не по времени прихода.
// search — строка запроса страницы (window.location.search). Передаётся, а не
// читается из глобала: так трекер остаётся чистой функцией и проверяется юнитом без
// поднятия DOM.
export function createVisitTracker(
  slug: string,
  token: string,
  version: number,
  search: string,
): VisitTracker {
  const id = uuidv7()
  const utm = readUTM(search)
  let seq = 0

  const send = (lastBlockId: string | null) => {
    const body = JSON.stringify({
      visit_id: id,
      token,
      version,
      seq: seq++,
      last_block_id: lastBlockId,
      utm,
    })
    // sendBeacon переживает закрытие вкладки, где обычный fetch уже отменяется.
    // Тип Blob задаёт Content-Type: заголовки этому API передать нельзя.
    const blob = new Blob([body], { type: 'application/json' })
    navigator.sendBeacon(`/public/v1/forms/${encodeURIComponent(slug)}/visits`, blob)
  }

  return {
    id,
    start: () => send(null),
    leave: (lastBlockId) => send(lastBlockId),
    reach: (blockId) => send(blockId),
  }
}
