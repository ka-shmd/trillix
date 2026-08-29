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

// Черновик ответов переживает F5 всегда, а закрытие вкладки — только если автор
// включил «Продолжить позже» (колонка forms.save_locally, 0044). Разница ровно в
// хранилище: sessionStorage живёт до закрытия вкладки, localStorage — дольше.
//
// ⚠ ОТВЕТЫ НЕ ПОКИДАЮТ БРАУЗЕР РЕСПОНДЕНТА ни в том, ни в другом случае. Это НЕ
// сбор незавершённых ответов (collect_partial): там черновик уезжает на сервер и его
// читает автор формы, здесь — нет.
//
// Ключ включает slug и версию: публикация новой версии обнуляет чужой черновик, а не
// подставляет старые ответы в изменившуюся форму.
const storageKey = (slug: string, version: number) => `trillix:answers:${slug}:${version}`

// Хранилище выбирается настройкой формы. Недоступное (приватный режим, отключённые
// куки в старых браузерах) бросает уже на обращении к свойству — поэтому доступ
// завёрнут, как и все операции ниже.
function store(local: boolean): Storage | null {
  try {
    return local ? localStorage : sessionStorage
  } catch {
    return null
  }
}

// sessionStorage мог быть подпорчен (другая вкладка, ручная правка) — читаем через
// Zod и при любом сбое возвращаем пустой черновик, а не роняем форму.
const answersStorageSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))

export function loadAnswers(slug: string, version: number, local = false): Answers {
  try {
    const raw = store(local)?.getItem(storageKey(slug, version))
    if (!raw) return {}
    return answersStorageSchema.parse(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function saveAnswers(slug: string, version: number, answers: Answers, local = false): void {
  try {
    store(local)?.setItem(storageKey(slug, version), JSON.stringify(answers))
  } catch {
    // Приватный режим/переполнение квоты — теряем только автосохранение черновика,
    // сама форма продолжает работать в памяти.
  }
}

// После успешной отправки черновик больше не нужен: чистим, чтобы F5 на экране
// «Спасибо» не воскресил заполненную форму.
// Чистит ОБА хранилища, а не то, что выбрано сейчас: настройку формы автор мог
// переключить, пока человек заполнял, и черновик, оставшийся в другом хранилище,
// всплыл бы у него на следующем открытии уже отправленной формы.
export function clearAnswers(slug: string, version: number): void {
  try {
    for (const s of [store(false), store(true)]) {
      s?.removeItem(storageKey(slug, version))
      s?.removeItem(pageKey(slug, version))
    }
  } catch {
    // Недоступный sessionStorage — ничего не делаем, черновик и так не сохранялся.
  }
}

// Номер открытой страницы (фаза 19) — рядом с черновиком ответов и по тем же
// правилам: переживает F5, умирает с вкладкой, привязан к версии. Без него
// перезагрузка на четвёртом шаге возвращала бы человека к первому вопросу при
// сохранённых ответах — худший из вариантов: заполненное есть, а где он был, забыто.
const pageKey = (slug: string, version: number) => `trillix:page:${slug}:${version}`

// pages — сколько страниц у формы: номер за пределами документа читать нельзя (форму
// могли переопубликовать короче, пока вкладка стояла открытой).
export function loadPage(slug: string, version: number, pages: number, local = false): number {
  try {
    const raw = store(local)?.getItem(pageKey(slug, version)) ?? null
    const n = raw === null ? 0 : Number.parseInt(raw, 10)
    return Number.isInteger(n) && n >= 0 && n < pages ? n : 0
  } catch {
    return 0
  }
}

export function savePage(slug: string, version: number, page: number, local = false): void {
  try {
    store(local)?.setItem(pageKey(slug, version), String(page))
  } catch {
    // Как и у ответов: теряем только запоминание шага, форма работает.
  }
}
