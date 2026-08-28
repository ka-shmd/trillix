// Чистая часть загрузчика (фаза 20): всё, что можно решить без DOM, — адрес фрейма,
// разбор data-атрибутов сниппета, проброс меток источника, проверка ссылки перехода.
//
// Разделение не косметическое: у рендерера нет testing-library (список зависимостей
// заморожен), поэтому проверяется юнитами ровно то, что живёт здесь, — а живёт здесь
// всё, где можно ошибиться молча. В v1.ts остаются только сборка узлов и подписки.

/** Как форма показана на чужой странице. */
export type EmbedMode = 'block' | 'widget' | 'page'

/** Угол, в котором стоит кнопка виджета. */
export type WidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

/**
 * Что открывает виджет: клик по кнопке или одно из наблюдений за посетителем.
 *
 * Автооткрытие срабатывает ОДИН РАЗ за загрузку страницы (см. `v1.ts`): всплывающая
 * снова и снова форма — это не второй шанс, а причина уйти с сайта.
 */
export type OpenTrigger = 'click' | 'delay' | 'scroll' | 'exit'

const TRIGGERS: readonly string[] = ['click', 'delay', 'scroll', 'exit']

/** Секунды до автооткрытия по задержке и доля прокрутки (%) для скролла. */
export const DEFAULT_OPEN_DELAY = 5
export const DEFAULT_OPEN_SCROLL = 50

export interface MountOptions {
  /** Короткий адрес формы, тот же, что в публичной ссылке. */
  form: string
  mode: EmbedMode
  /** Фон формы прозрачен — блок ложится на фон сайта, а не белым прямоугольником. */
  transparent?: boolean
  /** Высота до первого сообщения о размере: без неё блок прыгал бы с нуля. */
  height?: number
  /** Кто уходит по ссылке после отправки: 'top' — страница-хозяин, 'frame' — сам фрейм. */
  redirect?: 'top' | 'frame'
  /** Надпись на кнопке виджета. */
  label?: string
  position?: WidgetPosition
  /**
   * Высота блока следует за содержимым (умолчание). Выключено — фрейм остаётся ростом
   * `height`, а форма скроллится внутри него: так вставку ставят в сетку фиксированной
   * высоты, где растущий блок ломал бы раскладку чужой страницы.
   */
  dynamicHeight?: boolean
  /** Не показывать заголовок формы: на чужой странице над блоком обычно есть свой. */
  hideTitle?: boolean
  /** Ширина панели виджета в пикселях. */
  width?: number
  /** Тёмная подложка под панелью виджета (умолчание). */
  overlay?: boolean
  /** Что открывает виджет; `click` — умолчание. */
  open?: OpenTrigger
  /** Секунды у `delay`, проценты прокрутки у `scroll`. У остальных не значит ничего. */
  openValue?: number
  /** Убрать виджет со страницы после отправки ответа. */
  hideOnSubmit?: boolean
  /** Прижать содержимое влево независимо от оформления формы. */
  alignLeft?: boolean
  /**
   * Предпросмотр вставки: форма работает, но визит не считается и ответ не уходит.
   *
   * Ради экрана «Встроить» в кабинете, где вставка показывается ЭТИМ ЖЕ загрузчиком
   * (ADR §10). В сниппете, который получает владелец сайта, флага нет — кабинет
   * добавляет его только тому экземпляру, что живёт в макете.
   */
  preview?: boolean
  /**
   * Значения полей, известные приложению-хозяину: `{ '<id блока>': 'ivan@site.ru' }`.
   *
   * Полей НЕ создаёт: заполняет только те вопросы, которые автор формы добавил сам.
   * Ключ — id блока, тот же, которым адресуются ответы (design/embed.md §8).
   */
  prefill?: Record<string, string>
}

/** Надпись кнопки по умолчанию: нейтральная, годится и заявке, и опросу. */
export const DEFAULT_LABEL = 'Открыть форму'

/** Высота фрейма до первого `resize`. Форма из пары вопросов примерно столько и занимает. */
export const DEFAULT_HEIGHT = 520

/**
 * Ширина панели виджета. Не «модалка по центру», а колонка в углу страницы — отсюда и
 * число: 376 это ширина, при которой поля формы читаются, а чужой сайт остаётся виден
 * (замер Tally).
 */
export const DEFAULT_WIDTH = 376

// Метки источника — закрытый список, тот же, что у рендерера и сервера. Произвольные
// параметры чужой страницы в аналитику не уезжают.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']

/**
 * scriptOrigin — откуда грузиться форме: из адреса самого загрузчика.
 *
 * Захардкоженный домен сделал бы файл непроверяемым: на prod-local он тот же
 * `embed/v1.js`, но с `f.localhost`, и сниппет молча ходил бы в прод. Возвращает
 * пустую строку на нечитаемом адресе — вызывающий тогда просто ничего не делает.
 */
export function scriptOrigin(src: string): string {
  try {
    return new URL(src).origin
  } catch {
    return ''
  }
}

/**
 * frameSrc — адрес страницы формы во фрейме.
 *
 * Метки источника берутся с ХОСТ-страницы: внутри фрейма `location.search` — это уже
 * наш адрес, и без проброса utm-метки чужого лендинга не доехали бы до аналитики
 * никогда (та же причина, по которой их читает рендерер, а не сервер).
 */
export function frameSrc(origin: string, opts: MountOptions, hostSearch: string): string {
  const params = new URLSearchParams()
  params.set('embed', opts.mode)
  if (opts.transparent) params.set('bg', 'transparent')
  // Переход после отправки внутри фрейма может исполнить ТОЛЬКО фрейм: хост, получив
  // сообщение `redirect`, вправе лишь промолчать. Поэтому выбор владельца сайта едет
  // во фрейм параметром, а не остаётся знанием одного загрузчика.
  if (opts.redirect === 'frame') params.set('redirect', 'frame')
  if (opts.hideTitle) params.set('hideTitle', '1')
  if (opts.alignLeft) params.set('align', 'left')
  if (opts.preview) params.set('preview', '1')
  const host = new URLSearchParams(hostSearch)
  for (const key of UTM_KEYS) {
    const value = host.get(key)
    if (value) params.set(key, value)
  }
  // Предзаполнение — параметрами `pf.<id блока>`: адрес фрейма человеку не виден и
  // ссылкой не делится, а отдельный канал (сообщение после ready) стоил бы гонки
  // «форма уже нарисовалась пустой».
  for (const [blockId, value] of Object.entries(opts.prefill ?? {})) {
    if (value !== '') params.set('pf.' + blockId, value)
  }
  return origin + '/r/' + encodeURIComponent(opts.form) + '?' + params.toString()
}

/** Источник значений сниппета: сам тег `<script>` или контейнер с data-атрибутами. */
export interface AttrSource {
  getAttribute(name: string): string | null
}

/**
 * optionsFromAttrs — настройки вставки из data-атрибутов; null = это не наш узел.
 *
 * Настройки живут только здесь, на чужой странице, и никогда на сервере (решение
 * владельца 2026-08-05): одна форма может быть вставлена в трёх местах по-разному, и
 * серверная копия настроек всякий раз спорила бы с двумя другими вставками.
 */
export function optionsFromAttrs(el: AttrSource): MountOptions | null {
  // Виджет узнаётся по своему атрибуту, а не по data-mode: он единственный, кто
  // ничего не вставляет в поток страницы, и путать его с блоком опечаткой в режиме
  // («форма пропала со страницы») не стоит.
  const widget = el.getAttribute('data-trillix-widget')
  const form = widget ?? el.getAttribute('data-trillix-form')
  if (form === null || form === '') return null
  const label = el.getAttribute('data-label')
  const trigger = el.getAttribute('data-open')
  return {
    form,
    mode: widget ? 'widget' : el.getAttribute('data-mode') === 'page' ? 'page' : 'block',
    transparent: el.getAttribute('data-bg') === 'transparent',
    // Мусор в атрибуте (пусто, «500px», «много») — не повод схлопнуть блок в ноль.
    height: size(el.getAttribute('data-height'), DEFAULT_HEIGHT),
    // Умолчания ВКЛЮЧЕНЫ, поэтому читается только явное выключение: сниппеты, уже
    // стоящие на чужих сайтах, этих атрибутов не несут и обязаны вести себя как раньше.
    dynamicHeight: el.getAttribute('data-dynamic-height') !== '0',
    redirect: el.getAttribute('data-redirect') === 'frame' ? 'frame' : 'top',
    hideTitle: el.getAttribute('data-hide-title') === '1',
    alignLeft: el.getAttribute('data-align') === 'left',
    preview: el.getAttribute('data-preview') === '1',
    label: label !== null && label !== '' ? label : DEFAULT_LABEL,
    position: readPosition(el.getAttribute('data-position')),
    width: size(el.getAttribute('data-width'), DEFAULT_WIDTH),
    overlay: el.getAttribute('data-overlay') !== 'none',
    open: trigger !== null && TRIGGERS.includes(trigger) ? (trigger as OpenTrigger) : 'click',
    openValue: size(el.getAttribute('data-open-value'), 0),
    hideOnSubmit: el.getAttribute('data-hide-on-submit') === '1',
  }
}

/**
 * frameAdoption — разбор ГОТОВОГО фрейма двухтеговой вставки:
 * `<iframe data-trillix-src="…"> + <script src="…/embed/v1.js">`.
 *
 * Вторая форма сниппета (§2 EMBED.md). Настройки вида в ней уже уехали в адрес — его
 * собрал кабинет, — поэтому здесь не сборка, а ПРОВЕРКА чужой строки и добавление
 * того, чего в кабинете быть не могло: меток источника хост-страницы.
 *
 * null = фрейм не наш (нет атрибута, битый адрес, чужой origin, путь не `/r/{slug}`).
 * Проверка origin обязательна: загрузчик не должен становиться универсальным
 * подъёмником фреймов по адресу из разметки чужой страницы.
 *
 * Режим берётся из адреса, а не из атрибута: адрес — единственное, что описывает
 * вставку целиком, и разойтись эти два источника не могут. Всё, что не `page`,
 * считается блоком: фрейм стоит в потоке, и вести себя иначе он не может, что бы ни
 * было написано в `embed`.
 */
export function frameAdoption(
  origin: string,
  el: AttrSource,
  hostSearch: string,
): { src: string; opts: MountOptions } | null {
  const raw = el.getAttribute('data-trillix-src')
  if (origin === '' || !isHttpUrl(raw)) return null
  const url = new URL(raw)
  if (url.origin !== origin || !url.pathname.startsWith('/r/')) return null
  const form = decodeURIComponent(url.pathname.slice('/r/'.length))
  if (form === '' || form.includes('/')) return null

  // Метки источника — с ХОСТ-страницы, как и у собранного загрузчиком адреса
  // (`frameSrc`): в кабинете их знать неоткуда. Уже написанное в адресе не
  // переписывается — это выбор того, кто сниппет правил.
  const host = new URLSearchParams(hostSearch)
  for (const key of UTM_KEYS) {
    const value = host.get(key)
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value)
  }

  return {
    src: url.toString(),
    opts: {
      form,
      mode: url.searchParams.get('embed') === 'page' ? 'page' : 'block',
      // Высота фрейма записана в его собственном атрибуте `height`, а следование за
      // содержимым выключается `data-dynamic-height="0"` — тем же атрибутом, что у
      // однотегового сниппета.
      height: size(el.getAttribute('height'), DEFAULT_HEIGHT),
      dynamicHeight: el.getAttribute('data-dynamic-height') !== '0',
    },
  }
}

/** Число из атрибута; мусор и не-положительное дают умолчание. */
function size(raw: string | null, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Неизвестный угол — правый нижний: сниппет с опечаткой обязан показать кнопку, а не
// потерять её за краем экрана.
function readPosition(raw: string | null): WidgetPosition {
  return raw === 'bottom-left' || raw === 'top-right' || raw === 'top-left' ? raw : 'bottom-right'
}

/**
 * isHttpUrl — можно ли уводить сюда страницу-хозяина.
 *
 * Ссылку уже проверил сервер при публикации и ещё раз рендерер перед отправкой
 * сообщения, но она прилетает через границу фрейма и уходит в `location.assign` на
 * ЧУЖОЙ странице — доверять ей на месте использования нельзя (инвариант 4).
 */
export function isHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Сообщение фрейма, прошедшее проверку формы. Зеркалит HostMessage рендерера. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'page'; index: number }
  | { type: 'submit'; submissionId: string }
  | { type: 'redirect'; url: string }

/**
 * readFrameMessage — разбор `event.data`; null, если это не наше сообщение.
 *
 * На чужой странице в `message` прилетает чужой трафик — чаты, аналитика, расширения
 * браузера, — поэтому проверяются и метка источника, и версия, и форма полей. Проверка
 * origin остаётся на вызывающем: она про доверие, а не про разбор.
 */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>
  if (msg.source !== 'trillix' || msg.v !== 1) return null
  switch (msg.type) {
    case 'ready':
      return { type: 'ready' }
    case 'resize':
      return typeof msg.height === 'number' && msg.height > 0
        ? { type: 'resize', height: msg.height }
        : null
    case 'page':
      return typeof msg.index === 'number' ? { type: 'page', index: msg.index } : null
    case 'submit':
      return typeof msg.submissionId === 'string'
        ? { type: 'submit', submissionId: msg.submissionId }
        : null
    case 'redirect':
      return isHttpUrl(msg.url) ? { type: 'redirect', url: msg.url } : null
    default:
      return null
  }
}
