import { useState } from 'react'

// ДВЕ ШТОРКИ РЕДАКТОРА — ОДНО СОСТОЯНИЕ ИЗ ТРЁХ ЗНАЧЕНИЙ, а не два независимых флага.
// Обе выезжают справа на одну ширину и отодвигают оболочку ОДНОЙ переменной
// (`shared/appDrawer.ts`): открытые вместе они лягут друг на друга, а закрытие первой
// снимет отступ из-под второй — шапка и полотно поедут назад под всё ещё открытую
// панель.
//
// Хук отдаёт открывалки и НЕ отдаёт сырой setState намеренно. Пока правило жило
// обёртками рядом с двумя `useState`, кнопка «Оформление» в верхнем баре звала сеттер
// мимо них — и открывала оформление поверх чата (нашло ревью 2026-09-02). Правило,
// которое можно обойти, обходят.
export function useEditorDrawers() {
  const [open, setOpen] = useState<'none' | 'chat' | 'design'>('none')
  // Закрытие закрывает ТОЛЬКО себя: `onOpenChange(false)` у шторки, которая и так не
  // открыта (Radix зовёт его и на Esc), иначе захлопывало бы соседку.
  const close = (who: 'chat' | 'design') => (cur: typeof open) => (cur === who ? 'none' : cur)
  return {
    chatOpen: open === 'chat',
    designOpen: open === 'design',
    openChat: (v: boolean) => setOpen(v ? 'chat' : close('chat')),
    openDesign: (v: boolean) => setOpen(v ? 'design' : close('design')),
  }
}
