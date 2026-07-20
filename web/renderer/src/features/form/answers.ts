import { z } from 'zod'

import { type Answer } from '@fields/answer'

// Ответы формы: карта blockId → значение. Живёт в useReducer (web/CLAUDE.md: в
// рендерере стейт на useReducer, без стора и Query).
export type Answers = Record<string, Answer>
export type AnswersAction = { type: 'set'; blockId: string; value: Answer }

export function answersReducer(state: Answers, action: AnswersAction): Answers {
  switch (action.type) {
    case 'set':
      return { ...state, [action.blockId]: action.value }
  }
}

// Черновик ответов переживает F5, но не закрытие вкладки — sessionStorage. Ключ
// включает slug и версию: публикация новой версии обнуляет чужой черновик, а не
// подставляет старые ответы в изменившуюся форму.
const storageKey = (slug: string, version: number) => `trillix:answers:${slug}:${version}`

// sessionStorage мог быть подпорчен (другая вкладка, ручная правка) — читаем через
// Zod и при любом сбое возвращаем пустой черновик, а не роняем форму.
const answersStorageSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))

export function loadAnswers(slug: string, version: number): Answers {
  try {
    const raw = sessionStorage.getItem(storageKey(slug, version))
    if (!raw) return {}
    return answersStorageSchema.parse(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function saveAnswers(slug: string, version: number, answers: Answers): void {
  try {
    sessionStorage.setItem(storageKey(slug, version), JSON.stringify(answers))
  } catch {
    // Приватный режим/переполнение квоты — теряем только автосохранение черновика,
    // сама форма продолжает работать в памяти.
  }
}

// После успешной отправки черновик больше не нужен: чистим, чтобы F5 на экране
// «Спасибо» не воскресил заполненную форму.
export function clearAnswers(slug: string, version: number): void {
  try {
    sessionStorage.removeItem(storageKey(slug, version))
  } catch {
    // Недоступный sessionStorage — ничего не делаем, черновик и так не сохранялся.
  }
}
