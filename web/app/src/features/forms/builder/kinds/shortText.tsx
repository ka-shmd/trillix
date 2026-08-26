import { type EditorKind } from './contract'

export const shortText: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Короткий ответ',
  description: 'Однострочный ответ — имя, короткая фраза, ссылка.',
  // Поверхность — инпут плейсхолдера: автор вводит в него текст, который увидит
  // респондент в пустом поле.
  row: { surface: 'placeholder', lineH: 'h-[var(--rf-control-h)]' },
}
