import { BUTTON_WIDTH_DEFAULT, type FormDesign } from '@entities/formSchema'

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

// Множители ритма: ритм полотна (12 по вертикали, 48 заголовок→форма) задан долями
// базы, поэтому плотность — один множитель на все интервалы, а не число на каждый.
const DENSITY_SCALE: Record<string, string> = { compact: '0.75', normal: '1', roomy: '1.25' }

// Стеки шрифтов. У каждого системный хвост на случай, если самохостный файл не
// догрузился, — и хвост подбирается ПО РИСУНКУ, а не копируется: у антиквы он засечный,
// иначе форма на секунду загрузки становится гротескной, то есть другой формой.
//
// Одного системного стека в списке НЕТ: он убран из каталога (DESIGN_FONTS), и
// незнакомое семейство здесь даёт undefined — форма набирается дефолтом :root.
const FONT_STACK: Record<string, string> = {
  inter: 'Inter, system-ui, -apple-system, sans-serif',
  golos: "'Golos Text', system-ui, -apple-system, sans-serif",
  manrope: 'Manrope, system-ui, -apple-system, sans-serif',
  onest: 'Onest, system-ui, -apple-system, sans-serif',
  montserrat: 'Montserrat, system-ui, -apple-system, sans-serif',
  lora: "Lora, Georgia, 'Times New Roman', serif",
}

// Состав переменных — контракт с Go-близнецом, поэтому он читается СПИСКОМ, а не
// собирается из двадцати ветвей. Паритет состава сторожит тест на стороне Go
// (design_vars_parity_test.go читает этот файл).
// Потолок ширины поля (--rf-input-max). Полная ширина — ЗНАЧЕНИЕ «100%», а не класс:
// переменная подставляется прямо в `max-width` и в `min(…, 100%)`, где проценты
// законны (у колонки страницы иначе — там число стоит внутри calc(), см.
// designClasses). Флаг сильнее числа: пока выбрана полная ширина, подобранные px
// просто ждут возврата к фиксированной.
//
// ОТДЕЛЬНОЙ ФУНКЦИЕЙ, А НЕ ВЫРАЖЕНИЕМ В ТАБЛИЦЕ: строка таблицы обязана оставаться
// ОДНОЙ строкой — её читает паритет-тест Go регуляркой `\['(--rf-[a-z-]+)'`, и
// перенос после открывающей скобки прячет переменную от сверки целиком.
const inputMax = (d: FormDesign): string | undefined =>
  d.controls?.fullWidth
    ? '100%'
    : d.controls?.width === undefined
      ? undefined
      : `${d.controls.width}px`

// Число в px или ничего. Ноль — законное значение у нескольких настроек, поэтому
// проверяется undefined, а не истинность: `?` съел бы ровно те случаи, ради которых
// ноль и открыт.
const px = (n: number | undefined): string | undefined => (n === undefined ? undefined : `${n}px`)

// Ширина кнопки: «во всю» — проценты, «фиксированная» — число автора (или дефолтные
// 200px, если он его не трогал), «по тексту» — ничего, кнопка растёт по содержимому.
//
// Число читается ТОЛЬКО в режиме fixed: в остальных оно лежит в документе и ждёт
// возврата — тот же приём, что у ширины поля.
const submitWidth = (d: FormDesign): string | undefined => {
  if (d.button?.width === 'full') return '100%'
  if (d.button?.width !== 'fixed') return undefined
  return `${d.button.widthPx ?? BUTTON_WIDTH_DEFAULT}px`
}

// Толщина надписи кнопки. `semibold` в таблице нет намеренно: это дефолт fields.css,
// и печатать для него переменную значило бы писать в документ то, что и так есть.
const BUTTON_WEIGHT: Record<string, string | undefined> = {
  normal: '400',
  medium: '500',
  bold: '700',
}

// Положение кнопки в ряду. `left` в таблице нет намеренно: это дефолт fields.css.
const SUBMIT_JUSTIFY: Record<string, string | undefined> = {
  center: 'center',
  right: 'flex-end',
}

const SPECS: ReadonlyArray<readonly [string, (d: FormDesign) => string | undefined]> = [
  ['--rf-canvas', (d) => d.palette?.canvas],
  ['--rf-field-bg', (d) => d.palette?.field],
  ['--rf-text', (d) => d.palette?.text],
  ['--rf-muted', (d) => d.palette?.muted],
  ['--rf-placeholder', (d) => d.palette?.placeholder],
  ['--rf-accent', (d) => d.palette?.accent],
  // Буквенный бейдж выбранного варианта — свой токен, хотя дефолты у него и у акцента
  // с 2026-08-22 совпали (оба #0070D7): прежде он был замерен у Tally чуть темнее
  // акцента, и соотношение не выражалось ни одним множителем. Совпадение дефолтов
  // ничего не отменяет — КАК ТОЛЬКО автор задал акцент, бейдж обязан ехать за ним,
  // иначе выбранный вариант получает синюю метку посреди зелёной формы.
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
  ['--rf-input-max', inputMax],
  // Высота контрола. Кнопка едет за ней сама: --rf-submit-h объявлен как
  // var(--rf-control-h) и пересчитается на том же контейнере (пока автор не задал
  // размер кнопки явно — тогда его значение сильнее).
  ['--rf-control-h', (d) => (d.controls?.height ? `${d.controls.height}px` : undefined)],
  // Край контрола: цвет и толщина рядом, хотя цвет и живёт в палитре, — порядок в
  // таблице сверяется с Go построчно, а читать их врозь незачем.
  ['--rf-ring', (d) => d.palette?.border],
  // Ноль — законное значение (кольцо исчезает), поэтому сравнение с undefined, а не
  // проверка на истинность: `?` съел бы ровно тот случай, ради которого ноль и открыт.
  ['--rf-ring-w', (d) => (d.controls?.borderWidth === undefined ? undefined : `${d.controls.borderWidth}px`)],
  // Ноль законен у обоих, поэтому сравнение с undefined, а не проверка на истинность.
  ['--rf-input-px', (d) => px(d.controls?.paddingX)],
  ['--rf-space-q', (d) => px(d.controls?.marginBottom)],
  ['--rf-radius', (d) => (d.controls?.radius === undefined ? undefined : `${d.controls.radius}px`)],
  // Кнопка. Положение — justify-content РЯДА (.rf-nav), а не align-self самой кнопки:
  // ряд горизонтальный, и align-self двигал бы её по вертикали, где двигать нечего.
  // При кнопке во всю ширину настройка инертна — свободного места не остаётся;
  // отдельной ветки для этого нет намеренно, инертное правило равно отсутствующему.
  // Три положения: слева — дефолт (ничего не печатаем), по центру и справа — свои
  // значения justify-content ряда.
  ['--rf-submit-size', (d) => px(d.button?.fontSize)],
  ['--rf-submit-weight', (d) => BUTTON_WEIGHT[d.button?.weight ?? '']],
  ['--rf-submit-radius', (d) => px(d.button?.radius)],
  ['--rf-submit-justify', (d) => SUBMIT_JUSTIFY[d.button?.align ?? '']],
  ['--rf-submit-width', submitWidth],
  // Число автора сильнее готового размера — и только по высоте: поля и кегль остаются
  // от набора, иначе одна правка высоты молча пересобирала бы кнопку целиком.
  ['--rf-submit-h', (d) => px(d.button?.height) ?? BUTTON_SIZE[d.button?.size ?? '']?.h],
  ['--rf-submit-mt', (d) => px(d.button?.marginTop)],
  // Число автора сильнее готового размера — как и у высоты.
  ['--rf-submit-px', (d) => px(d.button?.paddingX) ?? BUTTON_SIZE[d.button?.size ?? '']?.px],
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
//   • контурная кнопка — тот же довод;
//   • снятая тень — гасит ПАРУ токенов (near и far) одним решением автора, и держать
//     их порознь значило бы позволить снять половину тени.
// Всё остальное (цвета, числа, ширины) — переменные: их можно назвать значением.
export function designClasses(design: FormDesign | undefined): string {
  if (!design) return ''
  const out: string[] = []
  if (design.theme === 'dark') out.push('rf-theme-dark')
  if (design.controls?.outline === 'border') out.push('rf-outline-border')
  if (design.controls?.outline === 'none') out.push('rf-outline-none')
  if (design.controls?.shadow === false) out.push('rf-shadow-off')
  if (design.button?.variant === 'outline') out.push('rf-btn-outline')
  return out.join(' ')
}

// showFormBadge — рисовать ли бейдж «Сделано в Trillix». Намерение автора (живое
// свойство формы: `branding`, true = показывать) плюс разрешение тарифа: бейдж есть
// ВСЕГДА, кроме случая «автор просил снять И тариф это разрешает».
//
// Намерение приезжает АРГУМЕНТОМ, а не из оформления: бейдж не часть документа, как
// вопрос или заголовок (ADR §10), и в схеме его нет вовсе.
//
// Близнец Go-метода forms.Service.ShowBadge, но живёт для другого потребителя:
// РЕСПОНДЕНТУ решение печатает сервер (поле showBadge в ответе — клиенту про тарифы
// знать неоткуда), а АВТОРУ его считает кабинет, у которого снимок тарифа уже в руках.
// Правило одно, и оно записано в одном выражении на каждой стороне — расхождение
// означало бы, что превью показывает автору не ту форму, которую увидят люди.
export function showFormBadge(intent: boolean, canRemove: boolean): boolean {
  return !(!intent && canRemove)
}
