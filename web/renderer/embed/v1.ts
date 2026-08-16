// Загрузчик встроенной формы. Раздаётся как /embed/v1.js и живёт на чужих сайтах,
// откуда его не отозвать: НОМЕР ВЕРСИИ В ИМЕНИ — ЭТО КОНТРАКТ. Правки сюда — только
// обратно совместимые; всё, что ломает вставленные сниппеты, обязано стать v2.js
// (design/embed.md §3).
//
// Сниппет — один тег, без парного div:
//   <script src="https://f.trillix.ru/embed/v1.js" data-trillix-form="opros" async></script>
//   <script src="…/v1.js" data-trillix-widget="opros" data-label="Оставить заявку" async></script>
//   <script src="…/v1.js" data-trillix-form="opros" data-mode="page" async></script>
//
// Стили везде назначаются через CSSOM (`el.style.x = …`), а не атрибутом style: на
// сайте со строгой CSP без 'unsafe-inline' атрибут был бы отброшен и виджет остался
// бы неотличим от обычного div, тогда как свойства CSSOM политика не трогает.

import {
  DEFAULT_HEIGHT,
  DEFAULT_LABEL,
  DEFAULT_OPEN_DELAY,
  DEFAULT_OPEN_SCROLL,
  DEFAULT_WIDTH,
  frameSrc,
  isHttpUrl,
  optionsFromAttrs,
  readFrameMessage,
  scriptOrigin,
  type MountOptions,
} from './api'

/** Что хост может узнать о форме. Ответы не отдаются — они у владельца в кабинете. */
type EventName = 'ready' | 'submit' | 'close'

export interface EmbedHandle {
  close(): void
  on(event: EventName, handler: (payload: { submissionId?: string }) => void): void
}

interface Mounted {
  frame: HTMLIFrameElement
  opts: MountOptions
  handlers: { [K in EventName]?: ((payload: { submissionId?: string }) => void)[] }
  /** Виджет: оболочка модалки, у блока и страницы её нет. */
  overlay?: HTMLDivElement
  /** Виджет: кнопка на странице — её убирает `data-hide-on-submit`. */
  button?: HTMLButtonElement
}

const mounted: Mounted[] = []

// Откуда грузиться форме — из адреса самого загрузчика: prod-local и прод раздают
// один и тот же файл с разных доменов, и захардкоженный origin увёл бы вставку на
// чужой контур.
const current = document.currentScript as HTMLScriptElement | null
const ORIGIN = current ? scriptOrigin(current.src) : ''

function emit(entry: Mounted, event: EventName, payload: { submissionId?: string } = {}) {
  for (const handler of entry.handlers[event] ?? []) handler(payload)
}

function handleOf(entry: Mounted, close: () => void): EmbedHandle {
  return {
    close,
    on: (event, handler) => {
      const list = entry.handlers[event] ?? []
      list.push(handler)
      entry.handlers[event] = list
    },
  }
}

function createFrame(opts: MountOptions): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.src = frameSrc(ORIGIN, opts, window.location.search)
  // Название обязательно: без него скринридер объявляет фрейм безымянным.
  frame.title = 'Форма'
  frame.style.width = '100%'
  frame.style.border = '0'
  frame.style.display = 'block'
  // Внутреннего скролла у блока нет: высоту ведёт сообщение resize, прокручивает
  // страницу сам хозяин сайта. У режима 'page' наоборот — фрейм ростом с вьюпорт
  // и скроллится сам, поэтому там высота фиксирована, а resize не приходит вовсе.
  if (opts.mode === 'page') {
    frame.style.height = '100dvh'
  } else {
    frame.style.height = (opts.height ?? DEFAULT_HEIGHT) + 'px'
    // Скролл внутри фрейма запрещаем только там, где высоту ведёт содержимое. С
    // выключенным `data-dynamic-height` фрейм остаётся заданного роста, и прокрутка
    // формы обязана остаться — иначе длинная форма просто обрезается.
    if (opts.dynamicHeight !== false) frame.scrolling = 'no'
  }
  return frame
}

/** mount — форма блоком (или на весь экран) в указанном узле страницы. */
function mount(target: Element, opts: MountOptions): EmbedHandle | null {
  if (ORIGIN === '') return null
  const frame = createFrame(opts)
  const entry: Mounted = { frame, opts, handlers: {} }
  target.appendChild(frame)
  mounted.push(entry)
  return handleOf(entry, () => {
    frame.remove()
    const i = mounted.indexOf(entry)
    if (i >= 0) mounted.splice(i, 1)
  })
}

/**
 * mountFullPage — режим «страница»: форма ЗАМЕЩАЕТ СОБОЙ содержимое чужой страницы.
 *
 * Фрейм ложится фиксированным слоем во весь вьюпорт, а не встаёт в поток на месте
 * скрипта: в потоке «страница» отличалась от блока только высотой в 100dvh — то есть
 * ничем, кроме размера, и обещание режима не выполнялось. Здесь же под формой не
 * видно ни шапки сайта, ни его подвала, и прокрутка хозяина заперта: за фреймом
 * прокручивать нечего, а незапертая страница «уезжала» бы колесом поверх формы.
 *
 * Закрытия у режима нет намеренно: это не оверлей, а страница. Владелец сайта ставит
 * такой сниппет на отдельный адрес, где кроме формы ничего и не должно быть.
 */
function mountFullPage(opts: MountOptions): EmbedHandle | null {
  if (ORIGIN === '') return null
  const frame = createFrame(opts)
  frame.style.position = 'fixed'
  frame.style.inset = '0'
  frame.style.width = '100%'
  frame.style.zIndex = '2147483000'
  document.body.appendChild(frame)
  pageMounted = true
  lockScroll()
  const entry: Mounted = { frame, opts, handlers: {} }
  mounted.push(entry)
  return handleOf(entry, () => {
    frame.remove()
    pageMounted = false
    unlockScroll()
    const i = mounted.indexOf(entry)
    if (i >= 0) mounted.splice(i, 1)
  })
}

// --- Виджет: кнопка и модалка -----------------------------------------------
//
// Открытый виджет ровно один: две формы поверх друг друга — не сценарий, а способ
// запереть человека в двух вложенных ловушках фокуса.
let openWidgetEntry: Mounted | null = null
let opener: HTMLElement | null = null
let savedOverflow = ''
let savedPadding = ''

// СКРОЛЛ ЗАПИРАЕТСЯ ТОЛЬКО У ПОЛНОЭКРАННОГО ВИДЖЕТА. Панель в углу оставляет чужую
// страницу живой — это её смысл; запертый скролл там означал бы «сайт заблокирован
// формой, которую человек не открывал», особенно при автооткрытии.
//
// Флаг обязателен: запирает открытие, отпирает закрытие, а полноэкранность считается
// по вьюпорту и между этими моментами может измениться (поворот телефона).
let scrollLocked = false
// На странице стоит вставка режима 'page': её замок скролла живёт, пока живёт сама
// вставка, и закрытие виджета его снимать не вправе.
let pageMounted = false

function lockScroll() {
  if (scrollLocked) return
  // Полоса прокрутки исчезает вместе со скроллом, и страница под формой прыгает
  // вправо на её ширину. Компенсируем ровно этой шириной.
  const gap = window.innerWidth - document.documentElement.clientWidth
  savedOverflow = document.body.style.overflow
  savedPadding = document.body.style.paddingRight
  document.body.style.overflow = 'hidden'
  if (gap > 0) document.body.style.paddingRight = gap + 'px'
  scrollLocked = true
}

function unlockScroll() {
  if (!scrollLocked || pageMounted) return
  document.body.style.overflow = savedOverflow
  document.body.style.paddingRight = savedPadding
  scrollLocked = false
}

function closeWidget() {
  const entry = openWidgetEntry
  if (!entry?.overlay) return
  entry.overlay.style.display = 'none'
  if (entry.button) entry.button.style.display = ''
  openWidgetEntry = null
  unlockScroll()
  // Фокус возвращается туда, откуда виджет открыли: иначе человек, закрывший форму
  // с клавиатуры, оказывается в начале чужой страницы.
  opener?.focus()
  opener = null
  emit(entry, 'close')
}

// ВИДЖЕТ — ПАНЕЛЬ В УГЛУ, А НЕ МОДАЛКА ПО ЦЕНТРУ (правка владельца 2026-08-16 по
// образцу Tally). Разница не косметическая: панель встаёт там же, где стояла кнопка,
// и потому читается как её продолжение, а не как перехват страницы. Отсюда три
// следствия, каждое из которых раньше было наоборот:
//
//   • страница остаётся живой — скролл не запирается, а без затемнения по ней ещё и
//     можно кликать (подложка тогда пропускает события);
//   • фокус не запирается: уйти Tab'ом обратно на сайт — законный ход, а не побег из
//     модалки. Esc и кнопка закрытия остаются;
//   • затемнение (`data-overlay`) становится настройкой вида, а не признаком модальности.
//
// Полноэкранным виджет остаётся там, где панель в углу бессмысленна: узкий экран (на
// телефоне угол — это весь экран) и режим 'page', открытый программно.
function buildWidget(opts: MountOptions): Mounted {
  const corner = opts.position ?? 'bottom-right'
  const dim = opts.overlay !== false

  const overlay = document.createElement('div')
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.background = dim ? 'rgba(15, 23, 42, 0.55)' : 'transparent'
  overlay.style.display = 'none'
  overlay.style.padding = '24px'
  overlay.style.zIndex = '2147483000'
  // Без затемнения подложка обязана пропускать клики насквозь: она невидима и
  // растянута на весь вьюпорт, то есть иначе тихо блокировала бы весь чужой сайт.
  // Панели события возвращаются своим `pointerEvents`.
  overlay.style.pointerEvents = dim ? 'auto' : 'none'
  overlay.style.display = 'none'

  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', 'Форма')
  dialog.style.position = 'relative'
  dialog.style.pointerEvents = 'auto'
  dialog.style.background = '#ffffff'
  dialog.style.borderRadius = '12px'
  dialog.style.width = '100%'
  dialog.style.overflowY = 'auto'
  dialog.style.boxShadow = '0 24px 64px rgba(15, 23, 42, 0.35)'
  // Полоса прокрутки панели — тонкая и приглушённая: системная широкая полоса в окне
  // шириной 376 съедает край формы и выглядит как часть чужого сайта, а не наша.
  // Свойствами, а не псевдоэлементом `::-webkit-scrollbar`: вставить правило в чужой
  // документ нам нечем (стили назначаются только через CSSOM), а эта пара
  // поддерживается и в Firefox, и в свежем Chrome. Где не поддерживается — остаётся
  // системная полоса, то есть сегодняшний вид.
  dialog.style.setProperty('scrollbar-width', 'thin')
  dialog.style.setProperty('scrollbar-color', 'rgba(15, 23, 42, 0.25) transparent')

  // КРЕСТИК ЖИВЁТ НА ОБЁРТКЕ, А НЕ ВНУТРИ ПАНЕЛИ, и это не про вёрстку: панель — это
  // скролл-контейнер длинной формы, и лежащий внутри неё крестик уезжал вверх вместе с
  // содержимым. Человек, прокрутивший форму до середины, оставался без способа её
  // закрыть — кроме Esc, о котором он не знает. Обёртка не скроллится, поэтому кнопка
  // стоит на месте — и только на ней он может выступать за край панели, не попадая под
  // её `overflow-y: auto`.
  //
  // ФОН НЕПРОЗРАЧНЫЙ: кнопка наполовину висит над чужой страницей, наполовину над
  // формой (часто над обложкой), и полупрозрачная плашка с тёмным глифом на тёмном
  // фоне просто исчезала. Белый круг с тенью читается на любом из трёх.
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', 'Закрыть форму')
  close.textContent = '×'
  close.style.position = 'absolute'
  close.style.width = '28px'
  close.style.height = '28px'
  close.style.border = '0'
  close.style.borderRadius = '999px'
  close.style.background = '#ffffff'
  close.style.color = '#0f172a'
  close.style.fontSize = '18px'
  close.style.lineHeight = '1'
  close.style.cursor = 'pointer'
  close.style.boxShadow = '0 2px 8px rgba(15, 23, 42, 0.35)'
  close.style.zIndex = '2'
  close.addEventListener('click', closeWidget)

  // ОБЁРТКА нужна ради крестика: он висит на углу панели, ВЫСТУПАЯ за её край, а у
  // самой панели `overflow-y: auto` — там его бы срезало. Заодно обёртка не
  // скроллится, поэтому кнопка стоит на месте, пока длинная форма прокручивается.
  // Ничего не прячет и задаёт ширину, панель занимает её целиком.
  const panel = document.createElement('div')
  panel.style.position = 'relative'
  panel.style.width = '100%'
  panel.style.pointerEvents = 'auto'

  const frame = createFrame(opts)
  dialog.appendChild(frame)
  panel.appendChild(dialog)
  panel.appendChild(close)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const narrow = window.matchMedia('(max-width: 640px)')
  const place = () => {
    const full = opts.mode === 'page' || narrow.matches
    const top = corner === 'top-right' || corner === 'top-left'
    const left = corner === 'bottom-left' || corner === 'top-left'

    overlay.style.padding = full ? '0' : '24px'
    // Раскладка одна на все четыре угла: flex-контейнер во весь вьюпорт и два
    // выравнивания. Позиционировать панель координатами было бы то же самое, но в
    // четырёх ветках вместо двух строк.
    overlay.style.alignItems = full ? 'center' : top ? 'flex-start' : 'flex-end'
    overlay.style.justifyContent = full ? 'center' : left ? 'flex-start' : 'flex-end'

    panel.style.maxWidth = full ? 'none' : (opts.width ?? DEFAULT_WIDTH) + 'px'
    panel.style.height = full ? '100%' : 'auto'
    dialog.style.borderRadius = full ? '0' : '12px'
    // ПАНЕЛЬ НИЖЕ ВЬЮПОРТА, а не во всю его высоту (правка владельца 2026-08-16):
    // окно, растянутое от края до края, читается как модалка — ровно то, чем виджет
    // перестал быть. 680 — второй подход после 560: та высота оказалась мала под
    // форму из нескольких вопросов. Длинная форма скроллится внутри панели.
    dialog.style.maxHeight = full ? '100dvh' : 'min(680px, calc(100dvh - 48px))'
    dialog.style.minHeight = full ? '100dvh' : '0'

    // На весь экран крестик встаёт внутрь угла: снаружи у формы во весь вьюпорт места
    // нет — кнопка ушла бы за край экрана.
    close.style.top = full ? '12px' : '-14px'
    close.style.left = full ? '12px' : '-14px'
  }
  place()
  narrow.addEventListener('change', place)

  // Клик по подложке — но только по ней самой: клик внутри панели всплывает сюда же.
  // Без затемнения событий здесь нет вовсе (`pointer-events: none`), и это верно: там
  // клик мимо панели принадлежит чужому сайту, а не нам.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeWidget()
  })

  return { frame, opts, handlers: {}, overlay, button: widgetButtons[opts.form] }
}

/** Виджет занимает весь вьюпорт: на телефоне угла нет, а 'page' — это оверлей-страница. */
function fullScreen(opts: MountOptions): boolean {
  return opts.mode === 'page' || window.matchMedia('(max-width: 640px)').matches
}

/** open — показать форму виджетом. Фрейм создаётся при первом показе, не заранее. */
function open(opts: MountOptions, from: HTMLElement | null = null): EmbedHandle | null {
  if (ORIGIN === '') return null
  let entry = mounted.find((m) => m.overlay && m.opts.form === opts.form)
  // Уже открытый виджет не открываем повторно: второй lockScroll запомнил бы
  // «hidden» как исходное состояние страницы и оставил бы её запертой навсегда.
  if (entry && entry === openWidgetEntry) return handleOf(entry, closeWidget)
  // Другой виджет закрываем: две формы поверх друг друга — не сценарий, а способ
  // запереть человека в двух вложенных ловушках фокуса.
  if (openWidgetEntry) closeWidget()
  if (!entry) {
    // Форма грузится в момент открытия, а не при загрузке чужой страницы: иначе
    // визит засчитывался бы каждому, кто просто зашёл на сайт, и конверсия виджета
    // считалась бы от числа посетителей сайта.
    entry = buildWidget(opts)
    mounted.push(entry)
  }
  opener = from
  openWidgetEntry = entry
  entry.overlay!.style.display = 'flex'
  // Кнопка прячется на время показа: панель встаёт в её угол, и кнопка либо торчала
  // бы из-под панели, либо тускло просвечивала сквозь затемнение.
  if (entry.button) entry.button.style.display = 'none'
  if (fullScreen(entry.opts)) lockScroll()
  // ФОКУС ЗАБИРАЕТСЯ ТОЛЬКО У ОТКРЫТИЯ ПО ЖЕСТУ. Автооткрытие (пауза, прокрутка, уход
  // курсора) приходит само, и увести каретку из чужой формы или поиска на странице оно
  // права не имеет — панель просто появляется в углу.
  if (from) (entry.overlay!.querySelector('button') as HTMLButtonElement | null)?.focus()
  return handleOf(entry, closeWidget)
}

// Сколько кнопок уже стоит в каждом углу: две формы на одном лендинге — обычная
// вставка, а кнопки по умолчанию идут в один угол и легли бы одна на другую
// попиксельно. Вторая перекрывает первую целиком, и по виду страницы это неотличимо
// от «одна кнопка, всё работает».
const buttonsInCorner: Record<string, number> = {}

// Кнопка каждой формы — чтобы модалка, созданная позже, знала, что убирать после
// отправки (`data-hide-on-submit`). Ключ — форма: две вставки одной формы на странице
// это одна кнопка в глазах посетителя.
const widgetButtons: Record<string, HTMLButtonElement> = {}

/** Пауза перед уборкой виджета после отправки: экран благодарности надо успеть прочитать. */
const HIDE_AFTER_SUBMIT_MS = 2500

function createButton(opts: MountOptions) {
  const corner = opts.position ?? 'bottom-right'
  const taken = buttonsInCorner[corner] ?? 0
  buttonsInCorner[corner] = taken + 1
  const top = corner === 'top-right' || corner === 'top-left'

  const button = document.createElement('button')
  button.type = 'button'
  // ЭМОДЗИ НА КНОПКЕ НЕТ (правка владельца 2026-08-16): он живёт на углу открытой
  // панели. Кнопка — это надпись, и только она.
  button.textContent = opts.label ?? DEFAULT_LABEL
  button.style.position = 'fixed'
  // Смещение считается от своего края: у верхних углов кнопки растут вниз, у нижних —
  // вверх, и в обоих случаях вторая не ложится на первую.
  button.style[top ? 'top' : 'bottom'] = 24 + taken * 60 + 'px'
  if (corner === 'bottom-left' || corner === 'top-left') button.style.left = '24px'
  else button.style.right = '24px'
  button.style.padding = '12px 20px'
  button.style.border = '0'
  button.style.borderRadius = '999px'
  button.style.background = '#0f172a'
  button.style.color = '#ffffff'
  button.style.fontSize = '15px'
  button.style.fontFamily = 'inherit'
  button.style.cursor = 'pointer'
  button.style.boxShadow = '0 8px 24px rgba(15, 23, 42, 0.25)'
  button.style.zIndex = '2147482000'
  button.addEventListener('click', () => open(opts, button))
  document.body.appendChild(button)
  widgetButtons[opts.form] = button
  return button
}

// АВТООТКРЫТИЕ — РОВНО ОДИН РАЗ ЗА ЗАГРУЗКУ СТРАНИЦЫ. Форма, всплывающая снова после
// того, как её закрыли, читается не как второй шанс, а как повод уйти с сайта; поэтому
// сработавший триггер снимает свои подписки и больше не наблюдает ни за чем.
//
// Кнопка при этом остаётся: закрывший форму человек должен иметь способ вернуться.
function armTrigger(opts: MountOptions, button: HTMLButtonElement) {
  const trigger = opts.open ?? 'click'
  if (trigger === 'click') return

  let done = false
  const fire = () => {
    if (done) return
    done = true
    cleanup()
    open(opts, button)
  }

  let timer = 0
  const onScroll = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight
    // Страница короче экрана прокручивается нулём: считать долю не от чего, и ждать
    // прокрутки бессмысленно — показываем сразу.
    const passed =
      scrollable <= 0
        ? 100
        : (window.scrollY / scrollable) * 100
    if (passed >= (opts.openValue || DEFAULT_OPEN_SCROLL)) fire()
  }
  // Уход со страницы: курсор вышел через ВЕРХНЮЮ границу окна — к вкладкам и адресной
  // строке. На тач-устройствах события нет вовсе, и это не поломка: там уходят жестом,
  // которого браузер нам не показывает.
  const onExit = (event: MouseEvent) => {
    if (event.clientY <= 0) fire()
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer)
    window.removeEventListener('scroll', onScroll)
    document.removeEventListener('mouseout', onExit)
  }

  if (trigger === 'delay') {
    timer = window.setTimeout(fire, (opts.openValue || DEFAULT_OPEN_DELAY) * 1000)
    return
  }
  if (trigger === 'scroll') {
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return
  }
  document.addEventListener('mouseout', onExit)
}

// listen — все подписки на документ разом. Вызывается РОВНО ОДИН РАЗ за страницу,
// даже если файл выполнился дважды (см. bootstrap внизу): иначе один клик по
// `[data-trillix-open]` доходил бы до обоих экземпляров, и каждый строил бы свой
// фрейм — два визита на одно открытие и два `lockScroll`, второй из которых
// запоминает уже запертую страницу как исходное состояние и при закрытии
// восстанавливает `overflow: hidden` навсегда.
function listen() {
  // Esc закрывает — это первое, что пробует человек, у которого форма открылась не
  // вовремя. Слушатель один на страницу, а не на модалку.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openWidgetEntry) closeWidget()
  })

  // Триггер на чужом элементе: владелец сайта вешает форму на свою кнопку и не спорит
  // с нашим видом. Делегированием, а не подпиской на узлы, — элемент может появиться
  // после загрузки (SPA, аккордеон, модалка).
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null
    const trigger = target?.closest?.('[data-trillix-open]')
    if (!trigger) return
    const form = trigger.getAttribute('data-trillix-open')
    if (!form) return
    event.preventDefault()
    open({ form, mode: 'widget' }, trigger as HTMLElement)
  })

  window.addEventListener('message', onFrameMessage)
}

// --- Сообщения фрейма --------------------------------------------------------
//
// Единый слушатель на все фреймы страницы: их может быть несколько, и заводить
// подписку на каждый незачем. Свой фрейм узнаём по contentWindow, а не по
// придуманному идентификатору, — сравнение работает без договорённостей с фреймом.
const onFrameMessage = (event: MessageEvent) => {
  if (ORIGIN === '' || event.origin !== ORIGIN) return
  const entry = mounted.find((m) => m.frame.contentWindow === event.source)
  if (!entry) return
  const msg = readFrameMessage(event.data)
  if (msg === null) return

  switch (msg.type) {
    case 'ready':
      emit(entry, 'ready')
      return
    case 'resize':
      // У полноэкранного режима высота — вьюпорт хоста, и следовать за содержимым
      // ей нельзя: форма из двух вопросов схлопнула бы фрейм до своей высоты. С
      // выключенным `data-dynamic-height` владелец сайта попросил о том же для блока.
      if (entry.opts.mode !== 'page' && entry.opts.dynamicHeight !== false) {
        entry.frame.style.height = msg.height + 'px'
      }
      return
    case 'page': {
      // Смена шага меняет высоту рывком, и чужая страница уезжает: человек оказывается
      // в середине нового шага. Подтягиваем фрейм — но ТОЛЬКО если его верх ушёл выше
      // вида: иначе дёргали бы страницу под тем, кто и так всё видит. В модалке
      // прокручивать чужую страницу нельзя вовсе — там свой скролл.
      if (entry.overlay) return
      const rect = entry.frame.getBoundingClientRect()
      if (rect.top < 0) entry.frame.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    case 'submit':
      emit(entry, 'submit', { submissionId: msg.submissionId })
      // «Убрать после отправки»: закрываем окно и уносим кнопку со страницы. Экран
      // благодарности при этом человек увидеть успевает — сообщение приходит после
      // его отрисовки, а закрытие ждёт своей паузы.
      if (entry.opts.hideOnSubmit && entry.overlay) {
        setTimeout(() => {
          if (openWidgetEntry === entry) closeWidget()
          entry.button?.remove()
        }, HIDE_AFTER_SUBMIT_MS)
      }
      return
    case 'redirect':
      // Переход после отправки: внутри фрейма он увёл бы человека в сайт внутри сайта,
      // поэтому его делает хозяин страницы. Ссылка проверена ещё раз — она прилетела
      // через границу фрейма и уходит в location чужого сайта.
      //
      // При `data-redirect="frame"` сюда вообще ничего не приходит: фрейм знает о
      // выборе владельца сайта (параметр `redirect=frame`) и уходит по ссылке сам.
      if (entry.opts.redirect !== 'frame' && isHttpUrl(msg.url)) window.location.assign(msg.url)
      return
  }
}

/**
 * attach — обработать один сниппет: вставить форму на место скрипта или завести
 * кнопку виджета.
 *
 * Публичный метод, а не внутренняя функция, потому что при двойном выполнении файла
 * второй экземпляр обязан отдать свой сниппет ПЕРВОМУ — иначе на странице появятся
 * два независимых реестра фреймов и два комплекта подписок.
 */
function attach(script: Element): void {
  const opts = optionsFromAttrs(script)
  if (!opts) return
  if (opts.mode === 'widget') {
    armTrigger(opts, createButton(opts))
    return
  }
  // «Страница» ничего не вставляет в поток: она накрывает чужую страницу целиком, и
  // место самого скрипта для неё значения не имеет.
  if (opts.mode === 'page') {
    mountFullPage(opts)
    return
  }
  if (!script.parentNode) return
  // Декларативный путь: сниппет-однотегович вставляет форму на место самого скрипта.
  // document.currentScript работает и с async (в отличие от модулей), поэтому парный
  // div на чужой странице не нужен — одна строка в буфере обмена, нечего перепутать.
  const slot = document.createElement('div')
  script.parentNode.insertBefore(slot, script)
  mount(slot, opts)
}

// Императивный путь — для приложений, где контейнер появляется после загрузки, а
// форма открывается по событию приложения (онбординг в SPA), а не по клику в разметке.
declare global {
  interface Window {
    Trillix?: {
      mount(target: Element, opts: MountOptions): EmbedHandle | null
      open(opts: MountOptions, from?: HTMLElement | null): EmbedHandle | null
      close(): void
      /** Внутреннее: второй экземпляр файла отдаёт свой сниппет первому. */
      attach?(script: Element): void
    }
  }
}

// Два сниппета на странице — это два тега с одним `src`, то есть ФАЙЛ ВЫПОЛНЯЕТСЯ
// ДВАЖДЫ. Идемпотентного глобала мало: состояние (реестр фреймов, запертый скролл,
// открытый виджет) и подписки на документ обязаны быть в единственном экземпляре,
// иначе один клик обслуживают оба, а страница остаётся запертой после закрытия.
// Поэтому второй экземпляр не инициализирует ничего — только передаёт свой тег
// первому и умолкает.
const prior = window.Trillix
if (prior?.attach) {
  if (current) prior.attach(current)
} else {
  listen()
  window.Trillix = { mount, open, close: closeWidget, attach }
  if (current) attach(current)
}
