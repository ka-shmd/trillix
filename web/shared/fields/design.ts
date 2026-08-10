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
  // Буквенный бейдж выбранного варианта — свой токен: у Tally он замерен чуть темнее
  // акцента (rgb(0,112,215) против rgb(0,122,255)), и это соотношение не выражается
  // ни одним множителем. Дефолт поэтому остаётся замеренным, но КАК ТОЛЬКО автор
  // задал акцент, бейдж обязан ехать за ним — иначе выбранный вариант получает
  // синюю метку посреди зелёной формы.
  ['--rf-accent-badge', (d) => d.palette?.accent],
  ['--rf-primary', (d) => d.palette?.button],
  ['--rf-primary-foreground', (d) => d.palette?.buttonText],
  ['--rf-font-family', (d) => (d.font ? FONT_STACK[d.font] : undefined)],
  ['--rf-font-size', (d) => (d.layout?.fontSize ? `${d.layout.fontSize}px` : undefined)],
  ['--rf-column', (d) => (d.layout?.width ? `${d.layout.width}px` : undefined)],
  ['--rf-density', (d) => (d.layout?.density ? DENSITY_SCALE[d.layout.density] : undefined)],
  ['--rf-align', (d) => d.layout?.align],
  // Второй токен той же настройки, а не дубль: карточки вариантов стоят в
  // flex-колонке, где выравнивание делает align-items, и ключевого слова `left` он
  // не понимает вовсе. Один токен на оба свойства дал бы центрированный текст в
  // карточках, прижатых влево.
  ['--rf-align-items', (d) => (d.layout?.align === 'center' ? 'center' : undefined)],
  ['--rf-radius', (d) => (d.controls?.radius === undefined ? undefined : `${d.controls.radius}px`)],
  // Кнопка. Положение — justify-content РЯДА (.rf-nav), а не align-self самой кнопки:
  // ряд горизонтальный, и align-self двигал бы её по вертикали, где двигать нечего.
  // При кнопке во всю ширину настройка инертна — свободного места не остаётся;
  // отдельной ветки для этого нет намеренно, инертное правило равно отсутствующему.
  ['--rf-submit-justify', (d) => (d.button?.align === 'center' ? 'center' : undefined)],
  ['--rf-submit-width', (d) => (d.button?.width === 'full' ? '100%' : undefined)],
  ['--rf-submit-h', (d) => BUTTON_SIZE[d.button?.size ?? '']?.h],
  ['--rf-submit-px', (d) => BUTTON_SIZE[d.button?.size ?? '']?.px],
  ['--rf-submit-ratio', (d) => BUTTON_SIZE[d.button?.size ?? '']?.ratio],
]

// Размеры кнопки. `md` в таблице нет намеренно: это дефолт fields.css, и печатать
// для него переменные значило бы писать в документ то, что и так есть.
const BUTTON_SIZE: Record<string, { h: string; px: string; ratio: string } | undefined> = {
  sm: { h: '2rem', px: '1rem', ratio: '0.75' },
  lg: { h: '2.75rem', px: '2rem', ratio: '1' },
}


// DESIGN_VAR_NAMES — ПОЛНЫЙ состав переменных, который может напечатать
// designToVars. Нужен тому, кто надевает оформление на общий узел (рендерер — на
// корень документа) и обязан сперва снять чужое: сервер печатает оболочку из своего
// снапшота, схема приезжает вторым запросом и кешируется отдельно, поэтому между
// ними бывает перекос — старая тёмная оболочка и новая светлая схема. Убрать только
// то, что ставишь сам, в этом случае недостаточно: снимать нечего, и форма остаётся
// тёмной до истечения кеша HTML.
//
// Выводится из той же таблицы SPECS, а не выписывается рядом вторым списком: второй
// список разошёлся бы на первой же новой переменной.
export const DESIGN_VAR_NAMES: readonly string[] = SPECS.map(([name]) => name)

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

// designClasses — классы контейнера формы.
//
// КЛАССОМ, А НЕ ПЕРЕМЕННОЙ, выражается ровно то, что является другим СПОСОБОМ
// РИСОВАНИЯ, а не другим значением:
//   • тема — `color-scheme` переменной не выразить, а без него тёмная форма получает
//     светлый скроллбар и белое автозаполнение поверх; и на тёмном холсте слоёная
//     тень не видна вовсе, поэтому кольцо с тенями переопределяются вместе с палитрой;
//   • контур — «рамка» и «без контура» зависят от темы (светлому холсту нужно тёмное
//     кольцо, тёмному светлое), и значением, не зная темы, это не выразить;
//   • контурная кнопка — тот же довод.
// Всё остальное (цвета, числа, ширины) — переменные: их можно назвать значением.
export function designClasses(design: FormDesign | undefined): string {
  if (!design) return ''
  const out: string[] = []
  if (design.theme === 'dark') out.push('rf-theme-dark')
  if (design.controls?.outline === 'border') out.push('rf-outline-border')
  if (design.controls?.outline === 'none') out.push('rf-outline-none')
  if (design.button?.variant === 'outline') out.push('rf-btn-outline')
  return out.join(' ')
}
