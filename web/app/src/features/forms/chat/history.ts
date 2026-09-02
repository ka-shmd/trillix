import type { ChatTurn } from './api'

// История разговора живёт НА КЛИЕНТЕ (ADR §10): сервер чата состояния не держит,
// поэтому реплики хранит вкладка и присылает их с каждым запросом.
//
// Хранилище вкладки, а не память компонента: шторка закрывается и открывается, а
// разговор обязан продолжаться; перезагрузка страницы его тоже переживает. Ключ —
// форма: разговоры про разные формы не смешиваются.
//
// Отказ хранилища НЕ ломает чат (приватный режим, запрет на сайт, переполнение):
// разговор просто живёт до перезагрузки — это хуже, чем сохранённый, и несравнимо
// лучше, чем неработающая шторка.

const PREFIX = 'trillix.chat.'

// KEEP — сколько реплик храним. Больше отправляемого потолка (MAX_CHAT_HISTORY):
// на экране разговор видно длиннее, чем видит модель.
const KEEP = 40

function key(formId: string): string {
  return PREFIX + formId
}

export function loadHistory(formId: string): ChatTurn[] {
  try {
    const raw = localStorage.getItem(key(formId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (t): t is ChatTurn =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as ChatTurn).text === 'string' &&
          ((t as ChatTurn).role === 'user' || (t as ChatTurn).role === 'assistant'),
      )
      .slice(-KEEP)
  } catch {
    return []
  }
}

export function saveHistory(formId: string, turns: ChatTurn[]): void {
  const value = JSON.stringify(turns.slice(-KEEP))
  try {
    localStorage.setItem(key(formId), value)
  } catch {
    // ПЕРЕПОЛНЕНИЕ ЧИСТИТ ЧУЖИЕ РАЗГОВОРЫ И ПРОБУЕТ ЕЩЁ РАЗ. Потолок стоял только на
    // длине одного разговора, а не на их числе: ключи копятся по форме и остаются
    // после её удаления, поэтому квота хранилища однажды выбирается — и тихий отказ
    // записи гасил сохранение разом у ВСЕХ форм, без единого признака в интерфейсе.
    // Свежий разговор дороже старых: их и роняем.
    dropOtherChats(key(formId))
    try {
      localStorage.setItem(key(formId), value)
    } catch {
      // Место не освободилось (переполнил не чат) — разговор живёт до перезагрузки.
      // Это хуже сохранённого и несравнимо лучше неработающей шторки.
    }
  }
}

// dropOtherChats — снести все сохранённые разговоры, кроме названного. Ключи
// перечисляются заранее: удаление на ходу сдвигает индексы localStorage.
function dropOtherChats(keep: string): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && k !== keep && k.startsWith(PREFIX)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    // Хранилище недоступно целиком — чистить нечего.
  }
}
