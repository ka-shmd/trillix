// Реализация адаптера каретки поверх contenteditable (фаза 14, этап 14.3) — та самая
// замена, ради возможности которой в фазе 13 вводился `caret.ts` (§2.6
// `docs/design/canvas-rework.md`). Обещание адаптера выполнено: поток клавиш строки и
// фокус-движок не переписывались — они говорят только с интерфейсом `CaretAdapter`.

import type { CaretAdapter } from './caret'
import { caretOffset, pointAt } from './richText'

const win = (el: HTMLElement) => el.ownerDocument.defaultView
const plainLen = (el: HTMLElement) => (el.textContent ?? '').length

// setCaret ставит схлопнутую каретку на смещение в плоском тексте.
export function setCaret(el: HTMLElement, offset: number): void {
  const view = win(el)
  const sel = view?.getSelection()
  if (!sel) return
  const at = pointAt(el, Math.max(0, Math.min(offset, plainLen(el))))
  const range = el.ownerDocument.createRange()
  range.setStart(at.node, at.offset)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

// setSelection восстанавливает выделение по смещениям в плоском тексте. Нужно после
// каждой команды форматирования: разрезание спанов меняет DOM-позиции, а смещения в
// тексте — нет, поэтому выделение переживает наложение марки и его видно на месте.
export function setSelection(el: HTMLElement, from: number, to: number): void {
  const sel = win(el)?.getSelection()
  if (!sel) return
  const len = plainLen(el)
  const a = pointAt(el, Math.max(0, Math.min(from, len)))
  const b = pointAt(el, Math.max(0, Math.min(to, len)))
  const range = el.ownerDocument.createRange()
  range.setStart(a.node, a.offset)
  range.setEnd(b.node, b.offset)
  sel.removeAllRanges()
  sel.addRange(range)
}

// selectionRange — выделение внутри строки в координатах плоского текста, или null,
// если выделения нет, оно схлопнуто или лежит вне этой строки. Именно в этих
// координатах работают все команды форматирования (§2.3 спеки).
export function selectionRange(el: HTMLElement): { from: number; to: number } | null {
  const sel = win(el)?.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null
  const from = caretOffset(el, r.startContainer, r.startOffset)
  const to = caretOffset(el, r.endContainer, r.endOffset)
  return from === to ? null : { from: Math.min(from, to), to: Math.max(from, to) }
}

// selectionRect — экранный прямоугольник выделения: панель форматирования встаёт над
// ним. Отдельно от selectionRange, потому что координаты нужны ровно одному
// потребителю, и happy-dom их не считает (`getClientRects` отдаёт нули) — позиция
// панели проверяется только в браузере.
export function selectionRect(el: HTMLElement): DOMRect | null {
  const sel = win(el)?.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  if (!el.contains(r.startContainer)) return null
  return r.getBoundingClientRect()
}

function collapsedAt(el: HTMLElement): number | null {
  const sel = win(el)?.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  if (!el.contains(r.startContainer)) return null
  return caretOffset(el, r.startContainer, r.startOffset)
}

export function richCaret(el: HTMLElement): CaretAdapter {
  return {
    focus(edge) {
      el.focus()
      setCaret(el, edge === 'start' ? 0 : plainLen(el))
    },
    // Схлопнутость проверяется здесь, а не в потоке: у textarea «каретка в начале» —
    // это selectionStart === selectionEnd === 0, и contenteditable обязан отвечать на
    // тот же вопрос так же, иначе Backspace начнёт схлопывать блок при выделении.
    caretAtStart: () => collapsedAt(el) === 0,
    caretAtEnd: () => collapsedAt(el) === plainLen(el),
    // Высота contenteditable естественная — подгонять нечего.
    autosize: () => {},
    text: () => ({
      value: el.textContent ?? '',
      caret: collapsedAt(el) ?? plainLen(el),
    }),
  }
}
