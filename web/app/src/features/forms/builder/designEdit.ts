import type { FormDesign } from '@entities/formSchema'

// Правка одного поля оформления (фаза 22, слайс 4) — отдельным модулем, а не внутри
// компонента, по той же причине, что designTheme.ts: тут вся тонкость, и проверяется
// она таблицей кейсов, а не кликами по Radix-контролам, которые happy-dom не
// открывает (STATUS.md).

export type PaletteField =
  | 'canvas'
  | 'field'
  | 'text'
  | 'muted'
  | 'accent'
  | 'button'
  | 'buttonText'

// Порядок — как в панели: сверху вниз от «самого крупного» к деталям. Он же порядок
// в схеме и в designToVars, и держать его одинаковым дешевле, чем однажды искать,
// почему панель показывает не то, что печатается.
export const PALETTE_FIELDS: ReadonlyArray<{ key: PaletteField; title: string }> = [
  { key: 'canvas', title: 'Фон страницы' },
  { key: 'field', title: 'Фон полей' },
  { key: 'text', title: 'Текст' },
  { key: 'muted', title: 'Приглушённый текст' },
  { key: 'accent', title: 'Акцент' },
  { key: 'button', title: 'Кнопка' },
  { key: 'buttonText', title: 'Текст кнопки' },
]

// Готовые цвета выборщика. Не палитра продукта (её нет и не будет — ADR §10: цвет
// свободный), а всего лишь удобные стартовые точки.
export const SWATCHES = [
  '#1a1a1a',
  '#37352f',
  '#6b6b6b',
  '#ffffff',
  '#faf6f0',
  '#0f2e22',
  '#007aff',
  '#00875a',
  '#c2703d',
  '#b91c1c',
] as const

// patchTop — заменить поле ВЕРХНЕГО уровня (тема, шрифт, бейдж). Отдельно от patch,
// потому что это не группа: `font` стал скаляром, когда шрифт свели к одному на
// форму, и звать для него групповую правку значило бы получить `{font: {'': 'inter'}}`.
//
// Схлопывание пустого — то же самое и по той же причине (см. patch ниже). У `branding`
// оно же выражает «показывать бейдж»: снятие ключа и есть включённый бейдж.
export function patchTop(
  design: FormDesign | undefined,
  key: 'theme' | 'font' | 'branding',
  value: string | false | undefined,
): FormDesign | undefined {
  const next: Record<string, unknown> = { ...design }
  if (value === undefined) delete next[key]
  else next[key] = value
  return Object.keys(next).length === 0 ? undefined : (next as FormDesign)
}

// patch — заменить одно поле внутри группы оформления.
//
// ГЛАВНОЕ ЗДЕСЬ — СХЛОПЫВАНИЕ ПУСТОГО. Снятие последнего значения обязано убирать и
// саму группу, и весь `design`, иначе в схеме копятся пустые объекты (`{palette:{}}`,
// `{layout:{}}`), которых автор не создавал: документ отличается от исходного при
// одинаковом виде — то же расхождение, из-за которого светлая тема хранится
// отсутствием ключа, а не `theme: 'light'`.
export function patch<K extends 'palette' | 'layout' | 'controls' | 'button'>(
  design: FormDesign | undefined,
  group: K,
  key: string,
  value: string | number | undefined,
): FormDesign | undefined {
  const nextGroup: Record<string, unknown> = { ...(design?.[group] as object) }
  if (value === undefined) delete nextGroup[key]
  else nextGroup[key] = value

  const next: Record<string, unknown> = { ...design }
  if (Object.keys(nextGroup).length === 0) delete next[group]
  else next[group] = nextGroup

  return Object.keys(next).length === 0 ? undefined : (next as FormDesign)
}
