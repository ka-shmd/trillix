import type { FormDesign } from '@entities/formSchema'

// ПЕРЕВОД ОФОРМЛЕНИЯ В CSS-ПЕРЕМЕННЫЕ — одна функция на три поверхности фронта:
// полотно редактора, превью билдера и публичный рендерер надевают результат на свой
// контейнер. Близнец на Go — DesignVars в internal/domain/design_vars.go: он печатает
// критические переменные прямо в <head> публичной страницы, чтобы тёмная форма не
// мигала белой до загрузки схемы.
//
// Живёт в @fields, а не в @entities, по тому же доводу, что вычислитель логики:
// это про ВИД полей, а не про форму документа, и читают его те же три поверхности,
// что и fields.css. В entities осталась только форма самих настроек (designSchema).
//
// Функция чистая: ни DOM, ни знания о поверхностях. Всё, что в ней есть, — таблицы
// перевода перечислимых значений в CSS и отсев незаданного.

// Ширины колонки в px. normal — замеренная ширина формы Tally (700), сегодня зашитая
// в .rf-form; narrow и wide — шаг в обе стороны.
const WIDTH_PX: Record<string, number> = { narrow: 560, normal: 700, wide: 860 }

// Множители ритма: ритм полотна (14/28/48, этап 13.3) задан долями базы, поэтому
// плотность — один множитель на все три интервала, а не три числа.
const DENSITY_SCALE: Record<string, string> = { compact: '0.75', normal: '1', roomy: '1.25' }

// Стеки шрифтов. Системный нулевого веса и потому дефолт; у остальных тот же
// системный хвост на случай, если самохостный файл не догрузился.
const FONT_STACK: Record<string, string> = {
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  inter: 'Inter, system-ui, -apple-system, sans-serif',
  golos: "'Golos Text', system-ui, -apple-system, sans-serif",
}

// Состав переменных — контракт с Go-близнецом, поэтому он читается СПИСКОМ, а не
// собирается из двадцати ветвей. Паритет состава сторожит тест на стороне Go
// (design_vars_parity_test.go читает этот файл).
const SPECS: ReadonlyArray<readonly [string, (d: FormDesign) => string | undefined]> = [
  ['--rf-canvas', (d) => d.palette?.canvas],
  ['--rf-field-bg', (d) => d.palette?.field],
  ['--rf-text', (d) => d.palette?.text],
  ['--rf-muted', (d) => d.palette?.muted],
  ['--rf-accent', (d) => d.palette?.accent],
  ['--rf-primary', (d) => d.palette?.button],
  ['--rf-primary-foreground', (d) => d.palette?.buttonText],
  ['--rf-font-family', (d) => (d.font?.body ? FONT_STACK[d.font.body] : undefined)],
  ['--rf-font-family-heading', (d) => (d.font?.heading ? FONT_STACK[d.font.heading] : undefined)],
  ['--rf-font-size', (d) => (d.layout?.fontSize ? `${d.layout.fontSize}px` : undefined)],
  ['--rf-column', (d) => (d.layout?.width ? `${WIDTH_PX[d.layout.width]}px` : undefined)],
  ['--rf-density', (d) => (d.layout?.density ? DENSITY_SCALE[d.layout.density] : undefined)],
  ['--rf-align', (d) => d.layout?.align],
  ['--rf-radius', (d) => (d.controls?.radius === undefined ? undefined : `${d.controls.radius}px`)],
]

// designToVars — переменные оформления для атрибута style контейнера.
//
// ПУСТОЙ объект для undefined и для design без единого заданного поля: это не
// оптимизация, а контракт фазы. Форма, у которой оформление не трогали, обязана
// выглядеть байт в байт как до неё, и надёжнее всего это держится тем, что мы не
// печатаем ни одного объявления.
export function designToVars(design: FormDesign | undefined): Record<string, string> {
  if (!design) return {}
  const vars: Record<string, string> = {}
  for (const [name, get] of SPECS) {
    const value = get(design)
    if (value) vars[name] = value
  }
  return vars
}

// themeClass — класс темы для контейнера; пусто у светлой (она же дефолт).
//
// Класс, а не переменные, по двум причинам. `color-scheme` переменной не выразить,
// а без него тёмная форма получает светлый скроллбар и белое автозаполнение
// поверх — заметный брак. И тёмная тема меняет не только цвета: на тёмном холсте
// слоёная тень не видна вовсе (тень на тёмном — не контур), поэтому кольцо и сила
// тени переопределяются вместе с палитрой.
export function themeClass(design: FormDesign | undefined): string {
  return design?.theme === 'dark' ? 'rf-theme-dark' : ''
}
