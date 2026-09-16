import type { FormCover, FormDesign, FormLogo } from '@entities/formSchema'

// Правка одного поля оформления (фаза 22, слайс 4) — отдельным модулем, а не внутри
// компонента, по той же причине, что designTheme.ts: тут вся тонкость, и проверяется
// она таблицей кейсов, а не кликами по Radix-контролам, которые happy-dom не
// открывает (STATUS.md).

export type PaletteField =
  | 'canvas'
  | 'field'
  | 'text'
  | 'muted'
  | 'placeholder'
  | 'border'
  | 'accent'
  | 'button'
  | 'buttonText'

// Цвета ВЕРХНЕГО РАЗДЕЛА — основные решения о виде формы (решение владельца
// 2026-08-28). Остальные цвета контракта разошлись по секции «Поля» и по списку
// скрытых; порядок — как в панели.
export const PALETTE_FIELDS: ReadonlyArray<{ key: PaletteField; title: string }> = [
  { key: 'canvas', title: 'Задний фон' },
  { key: 'text', title: 'Текст' },
  { key: 'accent', title: 'Акцент' },
]

// Цвета, которые показывает секция «Поля» (решение владельца 2026-08-29). Отдельный
// список, а не продолжение верхнего: там основные решения о виде формы, здесь —
// свойства одного элемента, и порядок в каждом свой.
export const FIELD_PALETTE_FIELDS: ReadonlyArray<{ key: PaletteField; title: string }> = [
  { key: 'field', title: 'Задний фон' },
  { key: 'placeholder', title: 'Плейсхолдер' },
]

// Цвет края контрола — своей строкой в ряду «Бордер · Ширина · Радиус», поэтому
// отдельно от FIELD_PALETTE_FIELDS: те два стоят рядом друг с другом, этот — рядом с
// толщиной и радиусом, то есть с настройками той же рамки.
export const BORDER_PALETTE_FIELD: { key: PaletteField; title: string } = {
  key: 'border',
  title: 'Бордер',
}

// Цвета секции «Кнопки» (решение владельца 2026-08-29). Подписи короткие: секция уже
// сказала, о чьём фоне и тексте речь.
export const BUTTON_PALETTE_FIELDS: ReadonlyArray<{ key: PaletteField; title: string }> = [
  { key: 'button', title: 'Задний фон' },
  { key: 'buttonText', title: 'Текст' },
]

// Цвета контракта, до которых в панели не добраться. Перечислены списком, а не
// опущены молча: тест сверяет объединение всех списков панели с составом схемы, поэтому
// новый цвет контракта обязан попасть в один из них — иначе он потерялся бы
// незаметно. Схемы это не касается: документ с этими полями принимается и рисуется
// как раньше, недоступна только правка руками.
export const PALETTE_FIELDS_HIDDEN: readonly PaletteField[] = ['muted']

// Готовые цвета выборщика. Не палитра продукта (её нет и не будет — ADR §10: цвет
// свободный), а всего лишь удобные стартовые точки.
export const SWATCHES = [
  '#1a1a1a',
  '#37352f',
  '#6b6b6b',
  '#ffffff',
  '#faf6f0',
  '#0f2e22',
  '#0070d7',
  '#00875a',
  '#c2703d',
  '#b91c1c',
] as const

// Палитра обложек — плитки окна обложки (CoverDialog): восемь светлых тонов и под
// ними те же оттенки плотнее, порядок столбцов общий. Свободный цвет остаётся
// доступен выборщиком рядом.
export const COVER_COLORS = [
  '#fecaca',
  '#fed7aa',
  '#fef08a',
  '#bbf7d0',
  '#bfdbfe',
  '#e9d5ff',
  '#fbcfe8',
  '#e5e7eb',
  '#f87171',
  '#fb923c',
  '#facc15',
  '#4ade80',
  '#60a5fa',
  '#c084fc',
  '#f472b6',
  '#9ca3af',
] as const

export const DEFAULT_COVER_COLOR = COVER_COLORS[0]

// patchTop — заменить поле ВЕРХНЕГО уровня (тема, шрифт, свой CSS). Отдельно от patch,
// потому что это не группа: `font` стал скаляром, когда шрифт свели к одному на
// форму, и звать для него групповую правку значило бы получить `{font: {'': 'inter'}}`.
//
// Схлопывание пустого — то же самое и по той же причине (см. patch ниже).
export function patchTop(
  design: FormDesign | undefined,
  key: 'theme' | 'font' | 'css',
  value: string | undefined,
): FormDesign | undefined {
  const next: Record<string, unknown> = { ...design }
  if (value === undefined) delete next[key]
  else next[key] = value
  return Object.keys(next).length === 0 ? undefined : (next as FormDesign)
}

// Правка числового размера ХРОМА страницы (стороны логотипа, его скругление, высота
// обложки). Отдельно от patch, потому что хром живёт не в `design`, а своими полями
// документа (`cover`/`logo`), и схлопывать его до undefined нельзя: объект держит саму
// картинку, а не только размеры.
//
// Снятое значение УДАЛЯЕТ ключ, а не пишет undefined: `{width: undefined}` уедет в
// автосейв как отсутствие ключа, но в сторе останется отличимым от исходного
// документа — и первое же сравнение «менялось ли» соврёт.
export function patchLogo(
  logo: FormLogo,
  key: 'width' | 'height' | 'radius',
  value: number | undefined,
): FormLogo {
  const next = { ...logo }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

export function patchCoverHeight(cover: FormCover, value: number | undefined): FormCover {
  const next = { ...cover }
  if (value === undefined) delete next.height
  else next.height = value
  return next
}

// coverFill — сменить НАПОЛНЕНИЕ обложки (цвет ↔ картинка), сохранив высоту полосы:
// высота — свойство полосы, а не того, чем она залита. Точка фокуса, наоборот, не
// переносится: у цвета её быть не может (схема отвергает), а у новой картинки другая
// композиция, и чужой сдвиг ей не подходит.
export function coverFill(
  cover: FormCover | undefined,
  fill: { color: string } | { imageKey: string },
): FormCover {
  return cover?.height === undefined ? fill : { ...fill, height: cover.height }
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
  // boolean — ради `layout.fullWidth`, единственного флага оформления: полная ширина
  // хранится наличием ключа, как и все остальные дефолты фазы (`true` или ничего).
  value: string | number | boolean | undefined,
): FormDesign | undefined {
  const nextGroup: Record<string, unknown> = { ...(design?.[group] as object) }
  if (value === undefined) delete nextGroup[key]
  else nextGroup[key] = value

  const next: Record<string, unknown> = { ...design }
  if (Object.keys(nextGroup).length === 0) delete next[group]
  else next[group] = nextGroup

  return Object.keys(next).length === 0 ? undefined : (next as FormDesign)
}
