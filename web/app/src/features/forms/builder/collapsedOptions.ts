import { create } from 'zustand'

import { isAnswerableType, isCaptionType, type Block } from '@entities/formSchema'
import { rowFacts } from './kinds/index'

// Свёрнутые вопросы на полотне (решение владельца 2026-09-15): вопрос с вариантами
// сворачивается шевроном у подписи — остаётся одна подпись, а прячутся варианты и все
// прочие строки группы; подпись называет, сколько блоков спрятано (варианты + строки).
//
// Это память РЕДАКТОРА, а не документ: превью и респондент видят всё, в схеме флага нет.
// Живёт в localStorage браузера — переживает перезагрузку, у соавтора своя. Не в сторе
// билдера: там каждая операция — шаг undo, а свернуть вопрос — не правка. Ключ — id поля
// выбора: он стабилен, а групп в документе нет (groupId выводится).
//
// Сворачивается только вопрос (подпись первой строкой группы): свёрнутое голое поле
// исчезло бы с полотна целиком, и развернуть его было бы не у чего. Пустой список не
// сворачивается — у него, кроме призрака «добавить», нет строк.
//
// Отказ хранилища (приватный режим, переполнение) сворачивание не ломает: оно живёт до
// перезагрузки.

const KEY = 'trillix.foldedOptions'

// KEEP — потолок числа запомненных id. Ключ копится по всем формам и не чистится при
// удалении блока; хвост старых свёрток роняется.
const KEEP = 500

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function save(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids].slice(-KEEP)))
  } catch {
    // Хранилище недоступно — свёртка живёт до перезагрузки.
  }
}

interface FoldState {
  ids: ReadonlySet<string>
  toggle(id: string): void
  expand(id: string): void
}

export const useFoldStore = create<FoldState>()((set, get) => ({
  ids: new Set(load()),
  toggle(id) {
    const next = new Set(get().ids)
    if (!next.delete(id)) next.add(id)
    save(next)
    set({ ids: next })
  },
  expand(id) {
    if (!get().ids.has(id)) return
    const next = new Set(get().ids)
    next.delete(id)
    save(next)
    set({ ids: next })
  },
}))

export interface FoldPlan {
  // Поле выбора вопроса — ключ свёртки.
  fieldId: string
  // Сколько блоков прячет свёртка: варианты поля + строки группы, кроме подписи и поля.
  count: number
  folded: boolean
}

// foldPlan — сворачивается ли вопрос (блоки ОДНОЙ группы по порядку) и что прячет.
// null — шеврона нет: группа без подписи первой строкой, без поля выбора или с пустым
// списком.
export function foldPlan(group: Block[], ids: ReadonlySet<string>): FoldPlan | null {
  const head = group[0]
  const field = group.find((b) => isAnswerableType(b.type))
  if (!head || !isCaptionType(head.type) || !field) return null
  if (rowFacts(field.type)?.surface !== 'choice') return null
  const options = field.settings?.options?.length ?? 0
  if (options === 0) return null
  return { fieldId: field.id, count: options + group.length - 2, folded: ids.has(field.id) }
}

// foldedRows — предикат «строка спрятана свёрткой своего вопроса» над плоским списком
// блоков, снимок стора на момент вызова. Нужен обработчикам вне рендера: обходу стрелками
// и исходам удалений (navigation.ts).
export function foldedRows(blocks: Block[]): (b: Block) => boolean {
  const ids = useFoldStore.getState().ids
  return (b) => {
    const group = blocks.filter((x) => x.groupId === b.groupId)
    return group[0]?.id !== b.id && foldPlan(group, ids)?.folded === true
  }
}
