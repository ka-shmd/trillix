import { z } from 'zod'

// Сборка кода для вставки формы на чужой сайт (фаза 20). Чистые функции: экран
// «Встроить» только показывает то, что здесь собрано, а юниты проверяют главное —
// что сниппет ведёт туда же, куда публичная ссылка, и что пользовательский текст
// не ломает разметку у владельца сайта.
//
// Настройки вставки нигде не сохраняются (решение владельца 2026-08-05): они живут
// в самом сниппете, на чужой странице, и правятся там же.

// Вид вставки живёт в адресе экрана «Встроить», поэтому у него есть схема разбора:
// параметр правят руками, и опечатка обязана дать умолчание, а не уронить экран.
export const embedModeSchema = z.enum(['block', 'widget', 'page'])
export type EmbedMode = z.infer<typeof embedModeSchema>
export const DEFAULT_EMBED_MODE: EmbedMode = 'block'

/**
 * withoutMode — search для ссылки, УВОДЯЩЕЙ С ЭКРАНА ВСТАВКИ.
 *
 * Вид вставки принадлежит этому экрану и за его пределами не значит ничего: ни один
 * другой экран его не читает. Но `search={(prev) => prev}`, которым ссылки кабинета
 * переносят пространство, переносит и его — и `?mode=block` тянулся за человеком по
 * разделам формы, оставаясь в адресе, которым он поделится.
 *
 * Снимается ИМЕННО ЗДЕСЬ, на выходе, а не на входе: маршрут-получатель чужие ключи не
 * вычищает — `validateSearch` разбирает адрес, но не переписывает его. Тот же приём и
 * по тому же доводу у периода аналитики (`shared/period.ts`, `withoutPeriod`).
 */
export function withoutMode<T extends object>(prev: T): Omit<T, 'mode'> {
  const rest = { ...prev } as T & { mode?: unknown }
  delete rest.mode
  return rest
}

/** Как вид вставки называется и что обещает — один текст на все три экрана. */
export const MODE_TITLES: Record<EmbedMode, string> = {
  block: 'Блок',
  widget: 'Виджет',
  page: 'Страница',
}
export const MODE_HINTS: Record<EmbedMode, string> = {
  block: 'Форма стоит в потоке страницы и растёт по мере заполнения',
  widget: 'Кнопка в углу экрана открывает форму поверх сайта',
  page: 'Форма занимает весь экран — удобно длинной анкете',
}

export type WidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center'

/**
 * РАСПОЛОЖЕНИЕ ВСПЛЫВАЮЩЕЙ ФОРМЫ — ДВА ВАРИАНТА (решение владельца 2026-08-28): панель
 * в правом нижнем углу и окно по центру. Прежние три угла кабинет больше не
 * предлагает; загрузчик их понимает по-прежнему — вставки с ними живут на чужих
 * сайтах, и контракт `v1.js` бессрочный (EMBED §2).
 */
export const WIDGET_POSITIONS: Partial<Record<WidgetPosition, string>> = {
  'bottom-right': 'Правый нижний угол',
  center: 'Центр',
}

/** Что открывает виджет. Зеркалит `OpenTrigger` загрузчика (`embed/api.ts`). */
export type OpenTrigger = 'click' | 'delay' | 'scroll' | 'exit'

export const OPEN_TRIGGERS: Record<OpenTrigger, string> = {
  click: 'По клику на кнопку сайта',
  delay: 'Через паузу после загрузки',
  scroll: 'Когда прокрутят страницу',
  exit: 'Когда уводят курсор со страницы',
}

export interface SnippetOptions {
  /** База публичной части — та же, что у ссылки на форму (publicUrl.ts). */
  baseUrl: string
  slug: string
  mode: EmbedMode
  /**
   * Название формы — оно же `title` фрейма: его читает скринридер и показывает
   * браузер вместо не загрузившегося фрейма. Безымянная форма даёт «Форма»
   * (`displayFormTitle`), поэтому пустым это поле в кабинете не бывает.
   */
  title?: string
  position?: WidgetPosition
  transparent?: boolean
  /** Высота простого iframe: у него авторесайза нет, размер задаётся сразу. */
  height?: number
  /** Высота блока следует за содержимым; выключено — фрейм фиксирован и скроллится сам. */
  dynamicHeight?: boolean
  /** Заголовок формы не показывать: над блоком на чужой странице обычно есть свой. */
  hideTitle?: boolean
  /** Ширина панели виджета. */
  width?: number
  /** Тёмная подложка под модалкой виджета. */
  overlay?: boolean
  /** Что открывает виджет. */
  open?: OpenTrigger
  /** Секунды у `delay`, проценты прокрутки у `scroll`. */
  openValue?: number
  /** Убрать виджет со страницы после отправки ответа. */
  hideOnSubmit?: boolean
  /** Прижать содержимое влево независимо от оформления формы. */
  alignLeft?: boolean
  /**
   * Предпросмотр: та же вставка, но форма не считает визит и не отправляет ответ.
   *
   * Флаг ставит ТОЛЬКО макет на экране «Встроить»; в коде, который видит и копирует
   * автор, его нет. Разница между показанным и исполненным кодом ровно в этом одном
   * атрибуте — и она существует затем, чтобы предпросмотр не оставлял следов
   * (ARCHITECTURE §10).
   */
  preview?: boolean
}

/** Высота простого `<iframe>` без загрузчика: подстраиваться ему нечем. */
export const PLAIN_IFRAME_HEIGHT = 720

/**
 * Высота блока до первого сообщения о размере — зеркалит `DEFAULT_HEIGHT` загрузчика
 * (`web/renderer/embed/api.ts`). Значение по умолчанию в сниппет не пишется: атрибут
 * без него означает ровно то же самое.
 */
export const DEFAULT_BLOCK_HEIGHT = 520

/** Ширина панели виджета — зеркалит `DEFAULT_WIDTH` загрузчика. */
export const DEFAULT_WIDGET_WIDTH = 376

/** Ширина окна по центру — зеркалит `DEFAULT_CENTER_WIDTH` загрузчика. */
export const DEFAULT_CENTER_WIDGET_WIDTH = 640

/**
 * widgetDefaults — умолчания вида ПО РАСПОЛОЖЕНИЮ (решение владельца 2026-08-28):
 * панель в углу и окно по центру начинают с разных ширины и затемнения.
 *
 * Ширина: в центре экрана колонка в 376 читается панелью, потерявшей свой угол.
 * Затемнение: панель — продолжение кнопки сайта, и потемневшая страница вокруг неё
 * спорит с этим жестом; окно по центру, наоборот, перехватывает внимание целиком, и
 * без подложки оно висит над чужой вёрсткой без всякой связи с ней.
 *
 * Ширина ЗЕРКАЛИТ `defaultWidth` загрузчика, и зеркало это несущее: `widgetAttrs`
 * пишет `data-width`, только когда автор отошёл от умолчания, — разъедься числа, и
 * поле в кабинете показывало бы одно, а посетитель видел бы другое.
 */
export function widgetDefaults(position: WidgetPosition): { width: number; overlay: boolean } {
  return position === 'center'
    ? { width: DEFAULT_CENTER_WIDGET_WIDTH, overlay: true }
    : { width: DEFAULT_WIDGET_WIDTH, overlay: false }
}

/**
 * ПАНЕЛЬ В УГЛУ НАЧИНАЕТ БЕЗ ЗАТЕМНЕНИЯ (`widgetDefaults`), а загрузчик без атрибута
 * его показывает, и это не расхождение: умолчание загрузчика — часть бессрочного
 * контракта `v1.js`, где вставки без атрибута уже работают на чужих сайтах. Поэтому
 * кабинет пишет `data-overlay="none"` явным атрибутом, а не переворачивает умолчание.
 */

/** Умолчания автооткрытия — зеркалят одноимённые значения загрузчика. */
export const DEFAULT_OPEN_DELAY = 5
export const DEFAULT_OPEN_SCROLL = 50

const loaderUrl = (baseUrl: string) => `${baseUrl}/embed/v1.js`

// Значение уезжает в HTML-атрибут на чужой странице. Кавычка в надписи кнопки
// («Оставить "заявку"») иначе оборвала бы атрибут и превратила остаток сниппета в
// мусор — на сайте, куда мы попасть уже не сможем.
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Сниппет с загрузчиком — один тег, без парного div. */
export function scriptSnippet(opts: SnippetOptions): string {
  const attrs: string[] = []
  if (opts.mode === 'widget') {
    attrs.push(`data-trillix-widget="${escapeAttr(opts.slug)}"`)
    // СВОЕЙ КНОПКИ ЗАГРУЗЧИК БОЛЬШЕ НЕ РИСУЕТ (решение владельца 2026-08-28): форму
    // открывает элемент сайта или вызов из кода. Атрибут пишется ЯВНО, потому что его
    // отсутствие для загрузчика значит «рисовать» — иначе вставки, стоящие на чужих
    // сайтах с прошлых месяцев, разом лишились бы кнопки (EMBED §2).
    attrs.push('data-button="none"')
    attrs.push(...widgetAttrs(opts))
    // Триггер и его значение пишутся вместе: «через паузу» без числа читалось бы как
    // «через сколько-то», а умолчание живёт в загрузчике и здесь не дублируется.
    if (opts.open && opts.open !== 'click') {
      attrs.push(`data-open="${opts.open}"`)
      if (opts.openValue) attrs.push(`data-open-value="${opts.openValue}"`)
    }
  } else {
    attrs.push(`data-trillix-form="${escapeAttr(opts.slug)}"`)
    if (opts.mode === 'page') attrs.push('data-mode="page"')
    if (opts.transparent) attrs.push('data-bg="transparent"')
    // Высота нужна только там, где фрейм стоит в потоке: у виджета её ведёт модалка,
    // у страницы — вьюпорт. Пишем, лишь когда автор отошёл от умолчания загрузчика.
    if (opts.mode === 'block' && opts.height && opts.height !== DEFAULT_BLOCK_HEIGHT) {
      attrs.push(`data-height="${opts.height}"`)
    }
    if (opts.mode === 'block' && opts.dynamicHeight === false) {
      attrs.push('data-dynamic-height="0"')
    }
    // ДВЕ НАСТРОЙКИ ВИДА ПИШУТСЯ НЕ ВО ВСЕХ РЕЖИМАХ, и оба ограничения — здесь, а не
    // только в панели: иначе включённая у блока настройка молча уезжала бы в сниппет
    // после переключения вида, где её контрола нет и увидеть её негде.
    //
    // Скрытый заголовок — не у страницы: там форма и есть вся страница, и прятать её
    // заголовок значит оставить документ вовсе без него.
    if (opts.hideTitle && opts.mode !== 'page') attrs.push('data-hide-title="1"')
    // Прижатие влево — только у блока: у виджета и страницы поля холста единственное,
    // что отделяет форму от края панели и края экрана (то же правило продублировано
    // селектором в рендерере — оно про вид, а не про кабинет).
    if (opts.alignLeft && opts.mode === 'block') attrs.push('data-align="left"')
    if (opts.preview) attrs.push('data-preview="1"')
  }
  return `<script src="${loaderUrl(opts.baseUrl)}" ${attrs.join(' ')} async></script>`
}

/** Текст кнопки-образца: его владелец сайта заменит на свой. */
const TRIGGER_TEXT = 'Оставить заявку'

/**
 * widgetAttrs — настройки ВИДА всплывающей формы, общие для двух её носителей: тега
 * скрипта (автооткрытие) и кнопки сайта (открытие по клику).
 *
 * Общие они не для краткости: разъехавшись, два места печатали бы одну настройку
 * по-разному, и «Расположение» в кабинете перестало бы совпадать с тем, что видит
 * посетитель, — в одном из двух случаев, то есть через раз.
 */
function widgetAttrs(opts: SnippetOptions): string[] {
  const attrs: string[] = []
  if (opts.position && opts.position !== 'bottom-right') {
    attrs.push(`data-position="${opts.position}"`)
  }
  // Умолчание считается от РАСПОЛОЖЕНИЯ, а не от одного числа: у окна по центру своя
  // ширина, и запиши мы её атрибутом — сниппет нёс бы `data-width="640"` там, где
  // загрузчик и так возьмёт 640.
  const fallback = widgetDefaults(opts.position ?? 'bottom-right').width
  if (opts.width && opts.width !== fallback) attrs.push(`data-width="${opts.width}"`)
  if (opts.overlay === false) attrs.push('data-overlay="none"')
  if (opts.hideOnSubmit) attrs.push('data-hide-on-submit="1"')
  if (opts.transparent) attrs.push('data-bg="transparent"')
  if (opts.hideTitle) attrs.push('data-hide-title="1"')
  if (opts.preview) attrs.push('data-preview="1"')
  return attrs
}

/**
 * triggerTag — КНОПКА САЙТА, к которой цепляется всплывающая форма.
 *
 * Своей кнопки у вставки больше нет (решение владельца 2026-08-28): её рисовал
 * загрузчик, и она всегда была чужой на чужом сайте — свой шрифт, свой цвет, свой
 * угол. Теперь форму открывает элемент владельца сайта, а мы даём образец, который он
 * заменит своим: атрибуты можно перенести на любую кнопку или ссылку.
 *
 * `hidden` — для макета на экране «Встроить»: там кнопка не нужна вовсе (автор пришёл
 * смотреть на форму), но открыть форму чем-то надо, и невидимый элемент оставляет
 * предпросмотру ровно тот путь, которым форма откроется на настоящем сайте.
 */
export function triggerTag(opts: SnippetOptions, hidden = false): string {
  const attrs = [`data-trillix-open="${escapeAttr(opts.slug)}"`, ...widgetAttrs(opts)]
  if (hidden) attrs.push('style="display:none"')
  return `<button type="button" ${attrs.join(' ')}>${escapeText(TRIGGER_TEXT)}</button>`
}

/** Текст между тегами: те же три знака, что у значений атрибутов (`escapeAttr`). */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * embedCode — ВСТАВКА, КОТОРУЮ КОПИРУЕТ АВТОР. Своя на каждый вид.
 *
 * Блок и страница — два тега: готовый `<iframe>` плюс загрузчик. Место фрейма держит
 * разметка, поэтому чужая страница не прыгает, когда фрейм появляется, а сам фрейм
 * автору виден: его можно двигать и оборачивать, не разбираясь в нашем коде.
 * Настройки вида уезжают в адрес фрейма — тот же, что и в «ссылке для вставки».
 *
 * Всплывающая форма — ДВЕ ФОРМЫ ВСТАВКИ, по способу открытия (решение владельца
 * 2026-08-28). По клику: тег загрузчика плюс кнопка-образец с `data-trillix-open` —
 * своей кнопки загрузчик больше не рисует, форму открывает элемент сайта. Само
 * («через паузу», «когда прокрутят», «когда уводят курсор»): один тег скрипта с
 * `data-button="none"` — открывать нечем и незачем, форма приходит сама.
 *
 * Обе формы поднимает один и тот же `embed/v1.js` (§2 EMBED.md).
 */
export function embedCode(opts: SnippetOptions): string {
  if (opts.mode !== 'widget') return `${frameTag(opts)}\n${loaderTag(opts.baseUrl)}`
  if ((opts.open ?? 'click') !== 'click') return scriptSnippet(opts)
  return `${loaderTag(opts.baseUrl)}\n${triggerTag(opts)}`
}

/**
 * previewCode — код, который исполняется в макете на экране «Встроить».
 *
 * От копируемого отличается двумя вещами, и обе про сцену, а не про поведение формы.
 * Первая — флаг `preview` (визит не считается, ответ не уходит). Вторая — только у
 * всплывающей формы: макет ВСЕГДА открывает её кликом по невидимой кнопке, каким бы
 * ни был настроенный триггер. Предпросмотр отвечает на «как это выглядит», а не «когда
 * появится»; ждать пять секунд паузы или прокручивать макет ради проверки вида —
 * работа, которой автор не просил.
 */
export function previewCode(opts: SnippetOptions): string {
  const preview: SnippetOptions = { ...opts, preview: true }
  if (preview.mode !== 'widget') return embedCode(preview)
  return `${loaderTag(preview.baseUrl)}\n${triggerTag(preview, true)}`
}

/**
 * loaderTag — тег загрузчика отдельно от фрейма.
 *
 * Нужен и сам по себе: тот, кто вставил форму ссылкой в Notion-подобный редактор,
 * добавляет этот тег на страницу ради подстройки высоты — фрейм у него уже есть.
 */
export function loaderTag(baseUrl: string): string {
  return `<script async src="${escapeAttr(loaderUrl(baseUrl))}"></script>`
}

/**
 * frameTag — фрейм двухтеговой вставки: адрес в `data-trillix-src`, а не в `src`.
 *
 * Пустой `src` не случайность и не «загрузим потом»: браузер начал бы грузить форму
 * до того, как загрузчик успел подставить метки источника хост-страницы, и половина
 * визитов пришла бы без них. Загрузчик проставляет адрес сам (`frameAdoption`).
 *
 * Геометрия — АТРИБУТАМИ, а не `style`, у всех режимов, кроме страницы: строгая CSP
 * без 'unsafe-inline' в `style-src` отбрасывает атрибут style, и блок остался бы
 * фреймом в 150 пикселей по умолчанию браузера. Странице деваться некуда — «во весь
 * вьюпорт» атрибутами не выражается.
 */
function frameTag(opts: SnippetOptions): string {
  const attrs = [`data-trillix-src="${escapeAttr(frameUrl(opts))}"`, 'loading="lazy"']
  if (opts.mode === 'page') {
    attrs.push('style="position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483000"')
  } else {
    // frameborder и margin* — атрибуты из HTML4, которых нет в современном
    // стандарте, и стоят они здесь не по недосмотру: рамку и внутренние поля фрейма
    // старые движки (в том числе встроенные браузеры мессенджеров) до сих пор берут
    // оттуда, а `style` на таком сайте может быть отброшен политикой. Цена — три
    // атрибута; выгода — блок без белой рамки и без отступа в 10 пикселей у тех, у
    // кого он иначе появится. Тот же набор в сниппете Tally.
    attrs.push(
      `width="100%" height="${opts.height ?? DEFAULT_BLOCK_HEIGHT}" frameborder="0" marginheight="0" marginwidth="0"`,
    )
    // Пишется только выключение: умолчание загрузчика — «высота следует за
    // содержимым», и вставки без атрибута обязаны вести себя как раньше.
    if (opts.dynamicHeight === false) attrs.push('data-dynamic-height="0"')
  }
  return `<iframe ${attrs.join(' ')} title="${escapeAttr(frameTitle(opts))}"></iframe>`
}

/**
 * frameTitle — что стоит в `title` фрейма: НАЗВАНИЕ ФОРМЫ, а не слово «Форма».
 *
 * Атрибут читает скринридер и показывает браузер вместо не загрузившегося фрейма, а
 * на чужой странице вставок может быть несколько — «Форма», «Форма», «Форма» не
 * различает их никак. Кабинет всегда передаёт непустую строку (`displayFormTitle`
 * подставляет «Форма» безымянной), но генератор зовут и из тестов — отсюда запасное
 * значение здесь.
 */
function frameTitle(opts: SnippetOptions): string {
  return opts.title !== undefined && opts.title.trim() !== '' ? opts.title : 'Форма'
}

/**
 * frameUrl — адрес формы во фрейме: то же, что строит загрузчик (`frameSrc`).
 *
 * Отдаётся автору и как «ссылка для вставки» (Notion, Ghost, Canva умеют вставлять
 * фрейм по адресу), и как `src` голого `<iframe>` — это один и тот же адрес, поэтому
 * и собирается в одном месте.
 */
export function frameUrl(opts: SnippetOptions): string {
  // У виджета своего адреса нет: модалка показывает ту же форму, что и блок.
  const params = new URLSearchParams({ embed: opts.mode === 'widget' ? 'block' : opts.mode })
  if (opts.transparent) params.set('bg', 'transparent')
  if (opts.hideTitle && opts.mode !== 'page') params.set('hideTitle', '1')
  if (opts.alignLeft && opts.mode === 'block') params.set('align', 'left')
  if (opts.preview) params.set('preview', '1')
  return `${opts.baseUrl}/r/${encodeURIComponent(opts.slug)}?${params.toString()}`
}

/**
 * Сниппет без загрузчика — голый `<iframe>`.
 *
 * Не запасной путь, а полноценный режим: сайт со строгой CSP (`script-src 'self'`)
 * наш скрипт не подключит вовсе, и таких среди корпоративных CMS достаточно. Цена
 * известна и показывается рядом: высота фиксированная, виджета не существует.
 */
export function iframeSnippet(opts: SnippetOptions): string {
  const src = frameUrl(opts)
  // «Страница» и без загрузчика обязана замещать содержимое, а не быть высоким блоком
  // в потоке: фиксированный слой во весь вьюпорт — единственное, чем это выражается в
  // одном теге. Остальным режимам хватает ширины и высоты.
  const style =
    opts.mode === 'page'
      ? 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483000'
      : 'border:0'
  const size =
    opts.mode === 'page' ? '' : ` width="100%" height="${opts.height ?? PLAIN_IFRAME_HEIGHT}"`
  return `<iframe src="${escapeAttr(src)}" title="${escapeAttr(frameTitle(opts))}"${size} style="${style}"></iframe>`
}

/**
 * openSnippet — вызов вставки из кода приложения.
 *
 * СПИСКА ПРЕДЗАПОЛНЯЕМЫХ ПОЛЕЙ ЗДЕСЬ БОЛЬШЕ НЕТ (решение владельца 2026-08-28):
 * экран кода отдаёт вызов, а не инструкцию к нему. Само предзаполнение никуда не
 * делось — оно живёт в загрузчике и рендерере (`prefill` в `MountOptions`, EMBED §7),
 * просто ключи и их ловушки объясняет вики, а не панель кабинета.
 */
export function openSnippet(opts: SnippetOptions): string {
  return `Trillix.open({\n  form: '${opts.slug}',\n  mode: '${opts.mode}',\n})`
}
