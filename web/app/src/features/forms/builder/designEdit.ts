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
  '#0070d7',
  '#00875a',
  '#c2703d',
  '#b91c1c',
] as const

// Палитра обложек: плотные, но не кричащие тона — обложка это фон под заголовком, а
// не акцент. Свободный цвет остаётся доступен тем же ColorPicker, что у текста;
// палитра лишь убирает пустой холст при первом клике. Читают её два места — оверлей
// на полотне (CoverEditor) и строка в панели (DesignChrome), поэтому живёт здесь, а
// не у одного из них.
export const COVER_COLORS = [
  '#e03e3e',
  '#d9730d',
  '#dfab01',
  '#0f7b6c',
  '#0b6e99',
  '#6940a5',
  '#ad1a72',
  '#64473a',
  '#787774',
  '#37352f',
] as const

export const DEFAULT_COVER_COLOR = COVER_COLORS[4]

// patchTop — заменить поле ВЕРХНЕГО уровня (тема, шрифт, бейдж). Отдельно от patch,
// потому что это не группа: `font` стал скаляром, когда шрифт свели к одному на
// форму, и звать для него групповую правку значило бы получить `{font: {'': 'inter'}}`.
//
// Схлопывание пустого — то же самое и по той же причине (см. patch ниже). У `branding`
// оно же выражает «показывать бейдж»: снятие ключа и есть включённый бейдж.
export function patchTop(
  design: FormDesign | undefined,
  key: 'theme' | 'font' | 'branding' | 'css',
  value: string | false | undefined,
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
