import type { Block, FormDesign } from '@entities/formSchema'

// ПРЕДУПРЕЖДЕНИЯ ПАНЕЛИ ОФОРМЛЕНИЯ (фаза 22, слайс 4). Обе проверки — именно
// предупреждения, а не запреты: автор вправе сделать некрасиво, и продукт, который
// не даёт покрасить форму в свои цвета, перестаёт быть настраиваемым конструктором.
//
// Отдельным модулем, а не внутри компонента, по той же причине, что designTheme.ts:
// это чистая арифметика, и проверяется она таблицей кейсов, а не кликами.

// ── 1. Контраст текста к фону ────────────────────────────────────────────────
//
// Считается по WCAG 2.1: относительная яркость с гамма-коррекцией, отношение
// (L1 + 0.05) / (L2 + 0.05). Порог AA для обычного текста — 4.5.
//
// Почему свои двадцать строк, а не библиотека: формула стабильна с 2008 года и
// умещается в функцию, а зависимость ради неё нарушала бы политику проекта.

const AA_NORMAL = 4.5

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number | null {
  if (!/^#[0-9a-f]{6}$/.test(hex)) return null
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// lowContrast — пара «текст на холсте» ниже порога AA. null, когда сравнивать
// нечего: один из цветов не задан автором, а дефолты темы мы заведомо проверили
// сами — предупреждать о них значило бы ругаться на собственный вид.
export function lowContrast(design: FormDesign | undefined): number | null {
  const text = design?.palette?.text
  const canvas = design?.palette?.canvas
  if (!text || !canvas) return null
  const ratio = contrastRatio(text, canvas)
  return ratio !== null && ratio < AA_NORMAL ? ratio : null
}

// ── 2. Крашеный текст при тёмной теме ────────────────────────────────────────
//
// ADR §10: цвет спана — абсолютный #rrggbb, за темой он НЕ следует. Фаза 22 сняла
// следствие «публичная форма остаётся светлой», но не сам конфликт: кусок текста,
// покрашенный в тёмный, на тёмном холсте пропадает.
//
// Решение владельца 2026-08-09 — разрешить и предупреждать, а не запрещать: цвет
// автора может быть на тёмном как раз хорош, и решать это ему.
// Считаются И цвет текста, И заливка куска: обе марки хранят абсолютный #rrggbb и
// обе за темой не следуют. Тёмная заливка на тёмном холсте пропадает так же, как
// тёмный текст, — забыть про bg значило бы предупреждать через раз.
export function coloredSpanCount(blocks: Block[]): number {
  let n = 0
  for (const b of blocks) {
    for (const span of b.text ?? []) {
      if (span.color || span.bg) n += 1
    }
  }
  return n
}

// darkThemeColorClash — сколько кусков текста рискуют пропасть. Ноль, если тема не
// тёмная: на светлом холсте цвет автора работает как задумано.
export function darkThemeColorClash(
  design: FormDesign | undefined,
  blocks: Block[],
): number {
  return design?.theme === 'dark' ? coloredSpanCount(blocks) : 0
}
