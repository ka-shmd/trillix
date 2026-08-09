import type { FormDesign } from '@entities/formSchema'

// Выбор темы в шторке «Оформление» (фаза 22, слайс 3) — отдельным модулем, а не
// внутри компонента, ровно чтобы это можно было проверить тестом: Radix Select в
// happy-dom не открывается вовсе (известная граница, STATUS.md), поэтому через
// разметку эта логика непокрываема, а тонкостей в ней две.

// currentTheme — что показывает дропдаун. Отсутствие темы и светлая тема — ОДНО
// состояние вида, и показывать их по-разному нельзя: форма, которой оформления не
// касались, выглядела бы «ничем не выбранной».
export function currentTheme(design: FormDesign | undefined): 'light' | 'dark' {
  return design?.theme === 'dark' ? 'dark' : 'light'
}

// withTheme — документ после выбора темы.
//
// СВЕТЛАЯ — ЭТО ОТСУТСТВИЕ КЛЮЧА, а не theme: 'light'. Довод тот же, что у всей
// фазы: форма, у которой тему включили и тут же выключили, обязана стать байт в байт
// прежней. Сохрани мы theme: 'light' — документ отличался бы от исходного, а вид
// нет; такое расхождение живёт вечно и всплывает годы спустя в диффе версий.
//
// Пустой результат схлопывается в undefined по той же причине: design: {} валиден,
// но это ключ в JSONB, которого автор не просил.
export function withTheme(
  design: FormDesign | undefined,
  theme: 'light' | 'dark',
): FormDesign | undefined {
  const next: FormDesign = { ...design }
  delete next.theme
  if (theme === 'dark') next.theme = 'dark'
  return Object.keys(next).length === 0 ? undefined : next
}
