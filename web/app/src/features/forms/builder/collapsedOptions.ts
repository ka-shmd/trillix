import { create } from 'zustand'

import type { Block } from '@entities/formSchema'
import { rowFacts } from './kinds/index'

// Свёрнутые списки вариантов на полотне (решение владельца 2026-09-15): вопрос с
// вариантами прячет их шевроном у подписи и подписывает, сколько спрятано.
//
// Это память РЕДАКТОРА, а не документ: превью и респондент видят все варианты, в схеме
// флага нет. Живёт в localStorage браузера — переживает перезагрузку, у соавтора своя.
// Не в сторе билдера: там каждая операция — шаг undo, а свернуть список — не правка.
//
// Сворачивается только список ВОПРОСА (с подписью, `ownedByQuestion` в BlockRow):
// свёрнутое голое поле исчезло бы с полотна целиком, и развернуть его было бы не у чего.
// Пустой список свёрнутым не бывает — прятать нечего, а призрак «добавить» у него
// единственная строка.
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

// canFold — есть ли у блока что сворачивать: список вариантов и хоть один вариант.
export function canFold(block: Block): boolean {
  return rowFacts(block.type)?.surface === 'choice' && (block.settings?.options?.length ?? 0) > 0
}

// isFolded — снимок для обработчиков вне рендера (обход стрелками, исходы удалений).
// Подпись у группы проверяет вызывающий: navigation.ts спрашивает её сам.
export function isFolded(block: Block): boolean {
  return canFold(block) && useFoldStore.getState().ids.has(block.id)
}
