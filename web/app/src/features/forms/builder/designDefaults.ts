import type { PaletteField } from './designEdit'

// ЦВЕТА ГОТОВЫХ ТЕМ — ЗЕРКАЛО `fields.css` (`:root` и `.rf-theme-dark`), ради одной
// строки панели: выборщик цвета показывает не «по теме», а тот цвет, который у формы
// сейчас на самом деле (решение владельца 2026-08-28). Автор видит, от чего
// отталкивается, ещё не тронув ни одного цвета.
//
// Мирится ровно то, что панель показывает, — холст, текст и акцент. Остальные токены
// темы сюда не переносятся: копия, которую никто не читает, разъедется молча.
//
// Значения записаны ДОСЛОВНО так, как стоят в CSS, а в hex переводятся здесь: сверять
// с `fields.css` можно строкой (это делает тест), а показывать автору нужно `#rrggbb` —
// в этой записи цвет и хранится в схеме, и вводится в поле выборщика.
const CSS_TOKENS: Record<'light' | 'dark', Partial<Record<PaletteField, string>>> = {
  // :root
  light: {
    canvas: 'oklch(1 0 0)', // --rf-canvas
    field: 'oklch(1 0 0)', // --rf-field-bg
    text: 'rgb(55, 53, 47)', // --rf-text
    placeholder: 'rgb(119, 118, 114)', // --rf-muted
    border: 'rgb(61 59 53 / 0.16)', // --rf-ring
    accent: 'rgb(0, 112, 215)', // --rf-accent
    button: 'oklch(0.208 0.042 265.755)', // --rf-primary
    buttonText: 'oklch(0.984 0.003 247.858)', // --rf-primary-foreground
  },
  // .rf-theme-dark
  dark: {
    canvas: 'oklch(0.19 0.006 60)', // --rf-canvas
    field: 'oklch(0.24 0.006 60)', // --rf-field-bg
    text: 'oklch(0.94 0.004 60)', // --rf-text
    placeholder: 'oklch(0.68 0.006 60)', // --rf-muted
    border: 'rgb(255 255 255 / 0.16)', // --rf-ring
    accent: 'rgb(58, 152, 255)', // --rf-accent
    button: 'oklch(0.94 0.004 60)', // --rf-primary
    buttonText: 'oklch(0.19 0.006 60)', // --rf-primary-foreground
  },
}

// Токен CSS, из которого взят каждый цвет. Нужен тесту-сторожу: он идёт в fields.css за
// парой «имя токена → значение» и сверяет её с таблицей выше.
export const PALETTE_CSS_VAR: Partial<Record<PaletteField, string>> = {
  canvas: '--rf-canvas',
  field: '--rf-field-bg',
  text: '--rf-text',
  // Плейсхолдер зеркалит --rf-MUTED, а не свой --rf-placeholder: последний объявлен
  // как var(--rf-muted), и сверять с fields.css нужно тот литерал, который в итоге
  // и рисуется.
  placeholder: '--rf-muted',
  border: '--rf-ring',
  accent: '--rf-accent',
  button: '--rf-primary',
  buttonText: '--rf-primary-foreground',
}

// Разбор записи CSS. Понимает ровно те нотации, которыми написаны токены выше:
// `rgb(r, g, b)`, `rgb(r g b / a)` и `oklch(L C H)`. На всём остальном — null:
// неизвестная запись, притворившаяся чёрным, была бы хуже честного «не знаю».
//
// Почему свои двадцать строк, а не библиотека: формула перевода oklch стабильна и
// умещается в функцию (тот же довод, что у контраста в designWarnings.ts).
function parseCssColor(css: string): { rgb: Rgb; alpha: number } | null {
  // Запятые и пробелы как разделители — обе записи законны и обе встречаются в
  // fields.css; альфа отделяется косой чертой (современный синтаксис) или запятой.
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[/,]\s*([\d.]+))?\s*\)$/.exec(css)
  if (rgb) {
    return {
      rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])],
      alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
    }
  }

  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css)
  if (oklch) {
    return { rgb: oklchToRgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3])), alpha: 1 }
  }

  return null
}

// cssColorToHex — плотный цвет в `#rrggbb`. Полупрозрачный отдаёт null: hex у него
// зависит от того, что под ним, и выбирать это за вызывающего здесь нечем.
export function cssColorToHex(css: string): string | null {
  const parsed = parseCssColor(css)
  return parsed === null || parsed.alpha !== 1 ? null : toHex(parsed.rgb)
}

// themeColor — цвет, который форма показывает СЕЙЧАС, если автор этот цвет не задавал.
// null у полей, которых в зеркале нет.
//
// ПОЛУПРОЗРАЧНЫЙ ТОКЕН СПЛЮЩИВАЕТСЯ ПО ХОЛСТУ ТЕМЫ. Такой в зеркале один — край
// контрола (`--rf-ring`, 16% чернил), и он рисуется тенью, то есть ЗА пределами
// заливки поля: под ним холст страницы, а не фон поля. Показать вместо него шашечки
// было бы формально честно и практически бесполезно — автор подбирает свой край,
// глядя на нынешний, а не на «неизвестно что».
export function themeColor(theme: 'light' | 'dark', key: PaletteField): string | null {
  const css = CSS_TOKENS[theme][key]
  if (css === undefined) return null
  const parsed = parseCssColor(css)
  if (parsed === null) return null
  if (parsed.alpha === 1) return toHex(parsed.rgb)

  const canvas = parseCssColor(CSS_TOKENS[theme].canvas ?? '')
  if (canvas === null) return null
  const over = (c: number, under: number) =>
    Math.round(c * parsed.alpha + under * (1 - parsed.alpha))
  return toHex([
    over(parsed.rgb[0], canvas.rgb[0]),
    over(parsed.rgb[1], canvas.rgb[1]),
    over(parsed.rgb[2], canvas.rgb[2]),
  ])
}

type Rgb = [number, number, number]

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
// Нижний регистр — требование валидатора схемы (HEX_COLOR), а не вкус: значение отсюда
// уезжает в выборщик начальным, и оттуда — в документ.
const toHex = (rgb: Rgb) => `#${rgb.map(hex2).join('')}`

// oklch → sRGB: цилиндрические координаты в oklab, oklab в линейный sRGB (матрицы
// Оттоссона), гамма-коррекция. Выход за пределы sRGB срезается по каналу — у наших
// собственных токенов его нет, но приведённый цвет всё равно лучше NaN в разметке.
function oklchToRgb(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)

  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3

  const linear: [number, number, number] = [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ]

  return linear.map(gamma) as Rgb
}

function gamma(v: number): number {
  const c = Math.min(1, Math.max(0, v))
  return Math.round(255 * (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c))
}
