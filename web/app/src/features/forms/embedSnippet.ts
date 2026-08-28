import { z } from 'zod'

import { isAnswerableType, plainText, type Block } from '@entities/formSchema'

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

export type WidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export const WIDGET_POSITIONS: Record<WidgetPosition, string> = {
  'bottom-right': 'Справа внизу',
  'bottom-left': 'Слева внизу',
  'top-right': 'Справа вверху',
  'top-left': 'Слева вверху',
}

/** Что открывает виджет. Зеркалит `OpenTrigger` загрузчика (`embed/api.ts`). */
export type OpenTrigger = 'click' | 'delay' | 'scroll' | 'exit'

export const OPEN_TRIGGERS: Record<OpenTrigger, string> = {
  click: 'По клику на кнопку',
  delay: 'Через паузу после загрузки',
  scroll: 'Когда прокрутят страницу',
  exit: 'Когда уводят курсор со страницы',
}

export interface SnippetOptions {
  /** База публичной части — та же, что у ссылки на форму (publicUrl.ts). */
  baseUrl: string
  slug: string
  mode: EmbedMode
  /** Надпись на кнопке виджета: вводит владелец формы, поэтому экранируется. */
  label?: string
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

/**
 * ПАНЕЛЬ КАБИНЕТА НАЧИНАЕТ БЕЗ ЗАТЕМНЕНИЯ, а загрузчик без атрибута его показывает, и
 * это не расхождение: умолчание загрузчика — часть бессрочного контракта `v1.js`, где
 * вставки без атрибута уже работают на чужих сайтах. Поэтому кабинет пишет
 * `data-overlay="none"` явным атрибутом, а не переворачивает умолчание.
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
    if (opts.label) attrs.push(`data-label="${escapeAttr(opts.label)}"`)
    if (opts.position && opts.position !== 'bottom-right') {
      attrs.push(`data-position="${opts.position}"`)
    }
    if (opts.width && opts.width !== DEFAULT_WIDGET_WIDTH) attrs.push(`data-width="${opts.width}"`)
    if (opts.overlay === false) attrs.push('data-overlay="none"')
    // Триггер и его значение пишутся вместе: «через паузу» без числа читалось бы как
    // «через сколько-то», а умолчание живёт в загрузчике и здесь не дублируется.
    if (opts.open && opts.open !== 'click') {
      attrs.push(`data-open="${opts.open}"`)
      if (opts.openValue) attrs.push(`data-open-value="${opts.openValue}"`)
    }
    if (opts.hideOnSubmit) attrs.push('data-hide-on-submit="1"')
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
  return `<script src="${loaderUrl(opts.baseUrl)}" ${attrs.join(' ')} async></script>`
}

/**
 * embedCode — ВСТАВКА, КОТОРУЮ КОПИРУЕТ АВТОР. Своя на каждый вид.
 *
 * Блок и страница — два тега: готовый `<iframe>` плюс загрузчик. Место фрейма держит
 * разметка, поэтому чужая страница не прыгает, когда фрейм появляется, а сам фрейм
 * автору виден: его можно двигать и оборачивать, не разбираясь в нашем коде.
 * Настройки вида уезжают в адрес фрейма — тот же, что и в «ссылке для вставки».
 *
 * Виджет — по-прежнему ОДИН тег скрипта: в потоке страницы ему нечего занимать,
 * кнопку и модалку строит загрузчик. Готовый `<iframe>` там был бы фреймом,
 * который никогда не показывают.
 *
 * Обе формы поднимает один и тот же `embed/v1.js` (§2 EMBED.md).
 */
export function embedCode(opts: SnippetOptions): string {
  if (opts.mode === 'widget') return scriptSnippet(opts)
  return `${frameTag(opts)}\n${loaderTag(opts.baseUrl)}`
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
    attrs.push(`width="100%" height="${opts.height ?? DEFAULT_BLOCK_HEIGHT}" frameborder="0"`)
    // Пишется только выключение: умолчание загрузчика — «высота следует за
    // содержимым», и вставки без атрибута обязаны вести себя как раньше.
    if (opts.dynamicHeight === false) attrs.push('data-dynamic-height="0"')
  }
  return `<iframe ${attrs.join(' ')} title="Форма"></iframe>`
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
  return `<iframe src="${escapeAttr(src)}" title="Форма"${size} style="${style}"></iframe>`
}

/** Одно предзаполняемое поле: id блока и подпись, которой вопрос назван в форме. */
export interface PrefillField {
  blockId: string
  caption: string
}

/**
 * prefillFields — вопросы формы, которые хост может заполнить заранее.
 *
 * Только отвечаемые блоки: у подписи и картинки ответа нет, заполнять нечего.
 * Подпись берётся из группы вопроса — той же строки, которой вопрос назван в CSV.
 *
 * **`multi_choice` исключён**: его ответ — массив id вариантов, а предзаполнение
 * передаёт строку. Предложи мы его здесь — разработчик вписал бы значение, рендерер
 * молча нарисовал бы «ничего не выбрано» (клиентской проверки у choice-типов нет), и
 * посетитель получил бы «ожидался список вариантов» на поле, которого не касался.
 * Рендерер такие значения отбрасывает независимо от этого списка (`applyPrefill`).
 */
export function prefillFields(blocks: Block[]): PrefillField[] {
  const captions = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'title' && block.type !== 'label') continue
    const text = plainText(block.text).trim()
    if (text && !captions.has(block.groupId)) captions.set(block.groupId, text)
  }
  return blocks
    .filter((block) => isAnswerableType(block.type) && block.type !== 'multi_choice')
    .map((block) => ({
      blockId: block.id,
      caption: captions.get(block.groupId) ?? 'Без заголовка',
    }))
}

/**
 * prefillSnippet — готовый вызов с объектом предзаполнения.
 *
 * Отдаём объект ЦЕЛИКОМ, со всеми полями и подписями в комментариях: ключ — id
 * блока (`blk_` + UUID), и собирать его по одному из интерфейса было бы мучением.
 * Скопировал, вписал свои переменные, лишние строки удалил.
 */
export function prefillSnippet(opts: SnippetOptions, fields: PrefillField[]): string {
  const lines = fields.map((f) => `    '${f.blockId}': '', // ${f.caption}`)
  const body = lines.length > 0 ? `\n  prefill: {\n${lines.join('\n')}\n  },` : ''
  return `Trillix.open({\n  form: '${opts.slug}',\n  mode: '${opts.mode}',${body}\n})`
}
