// Адаптер каретки строки (§2.6 спеки реворка) — узкая граница между клавиатурным
// потоком/фокус-движком полотна и текстовой поверхностью строки. Сегодня поверхность
// — <textarea> (каретка через selectionStart/selectionEnd); будущий rich-text
// (плоские спаны, ADR §10) заменит поверхность на contenteditable с другим API
// (Selection/Range), и тогда переписывается ТОЛЬКО реализация адаптера, а поток и
// движок не трогаются — они говорят с textarea исключительно через этот интерфейс.

// Край строки, на который встаёт каретка при фокусе.
export type CaretEdge = 'start' | 'end'

export interface CaretAdapter {
  // Фокус на поверхность с кареткой на нужном крае.
  focus(edge: CaretEdge): void
  // Каретка схлопнута в самом начале текста (для Backspace/↑ на границе строки).
  caretAtStart(): boolean
  // Каретка схлопнута в самом конце текста (для ↓ на границе строки).
  caretAtEnd(): boolean
  // Подгон высоты textarea под контент (автовысота, без скролла).
  autosize(): void
}

// textareaCaret — реализация адаптера поверх <textarea>. Дёшев, создаётся на каждый
// вызов от актуального элемента (identity элемента могла смениться при ре-рендере).
export function textareaCaret(el: HTMLTextAreaElement): CaretAdapter {
  return {
    focus(edge) {
      el.focus()
      const pos = edge === 'start' ? 0 : el.value.length
      el.setSelectionRange(pos, pos)
    },
    caretAtStart: () => el.selectionStart === 0 && el.selectionEnd === 0,
    caretAtEnd: () =>
      el.selectionStart === el.value.length && el.selectionEnd === el.value.length,
    autosize() {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    },
  }
}
