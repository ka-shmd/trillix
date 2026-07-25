// navigation.ts — чистая логика обхода полотна: какие строки принимают каретку при
// ОБЫЧНОЙ навигации (стрелки, Backspace-схлопывание, исходы удалений), а какие поток
// перескакивает.
//
// Инпут плейсхолдера — «лист», а не остановка потока (решение владельца 2026-07-24,
// уточняет §2.1/§2.4 спеки): каретка попадает в него только ЯВНО — Cmd/Ctrl+Enter
// («действие над ответом») или клик мышью. Стрелки, схлопывание и исходы удалений
// его обходят, приземляясь на подпись группы. Иначе плейсхолдер (необязательное поле)
// перехватывал каретку на каждом проходе, а пустой Backspace в нём удалял поле и
// оставлял подпись сиротой.
//
// Исключение — ГОЛОЕ поле (группа без подписи): у него нет другой поверхности, поток
// его пропустить не может, иначе оно недостижимо с клавиатуры («форма без мыши»).

import { isCaptionType, supportsPlaceholder, type Block } from '@entities/formSchema'

// groupHasCaption — в группе есть блок-подпись (title/label): «лицо» вопроса в потоке.
function groupHasCaption(blocks: Block[], groupId: string): boolean {
  return blocks.some((b) => b.groupId === groupId && isCaptionType(b.type))
}

// isFlowLeaf — строку поток перескакивает: инпут плейсхолдера в группе с подписью.
// Голое поле листом не считается (см. шапку модуля).
export function isFlowLeaf(blocks: Block[], b: Block): boolean {
  return supportsPlaceholder(b.type) && groupHasCaption(blocks, b.groupId)
}

// stopNeighbor — ближайшая строка-остановка от индекса i в сторону dir, перескакивая
// лист-поля. undefined — остановок в эту сторону нет (край полотна).
export function stopNeighbor(blocks: Block[], i: number, dir: 'up' | 'down'): Block | undefined {
  const step = dir === 'up' ? -1 : 1
  let j = i + step
  while (blocks[j] && isFlowLeaf(blocks, blocks[j]!)) j += step
  return blocks[j]
}
