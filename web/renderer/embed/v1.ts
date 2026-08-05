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
    frame.scrolling = 'no'
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

// --- Виджет: кнопка и модалка -----------------------------------------------
//
// Открытый виджет ровно один: две формы поверх друг друга — не сценарий, а способ
// запереть человека в двух вложенных ловушках фокуса.
let openWidgetEntry: Mounted | null = null
let opener: HTMLElement | null = null
let savedOverflow = ''
let savedPadding = ''

function lockScroll() {
  // Полоса прокрутки исчезает вместе со скроллом, и страница под модалкой прыгает
  // вправо на её ширину. Компенсируем ровно этой шириной.
  const gap = window.innerWidth - document.documentElement.clientWidth
  savedOverflow = document.body.style.overflow
  savedPadding = document.body.style.paddingRight
  document.body.style.overflow = 'hidden'
  if (gap > 0) document.body.style.paddingRight = gap + 'px'
}

function unlockScroll() {
  document.body.style.overflow = savedOverflow
  document.body.style.paddingRight = savedPadding
}

function closeWidget() {
  const entry = openWidgetEntry
  if (!entry?.overlay) return
  entry.overlay.style.display = 'none'
  openWidgetEntry = null
  unlockScroll()
  // Фокус возвращается туда, откуда виджет открыли: иначе человек, закрывший форму
  // с клавиатуры, оказывается в начале чужой страницы.
  opener?.focus()
  opener = null
  emit(entry, 'close')
}

function buildWidget(opts: MountOptions): Mounted {
  const overlay = document.createElement('div')
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.background = 'rgba(15, 23, 42, 0.55)'
  overlay.style.display = 'none'
  overlay.style.alignItems = 'center'
  overlay.style.justifyContent = 'center'
  overlay.style.padding = '24px'
  overlay.style.zIndex = '2147483000'

  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Форма')
  dialog.style.position = 'relative'
  dialog.style.background = '#ffffff'
  dialog.style.borderRadius = '12px'
  dialog.style.width = '100%'
  dialog.style.maxWidth = '640px'
  dialog.style.maxHeight = '90dvh'
  dialog.style.overflowY = 'auto'
  dialog.style.boxShadow = '0 24px 64px rgba(15, 23, 42, 0.35)'

  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', 'Закрыть форму')
  close.textContent = '×'
  close.style.position = 'absolute'
  close.style.top = '8px'
  close.style.right = '8px'
  close.style.width = '32px'
  close.style.height = '32px'
  close.style.border = '0'
  close.style.borderRadius = '8px'
  close.style.background = 'rgba(15, 23, 42, 0.06)'
  close.style.color = '#0f172a'
  close.style.fontSize = '20px'
  close.style.lineHeight = '1'
  close.style.cursor = 'pointer'
  close.style.zIndex = '1'
  close.addEventListener('click', closeWidget)

  const frame = createFrame(opts)
  dialog.appendChild(close)
  dialog.appendChild(frame)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  // На весь экран модалка идёт в двух случаях: узкий экран (отступы и скругления на
  // телефоне съедают форму, ради которой человек и нажал кнопку) и режим 'page',
  // открытый программно, — это и есть второй подрежим страницы, оверлей поверх
  // приложения (design/embed.md §2.5).
  const narrow = window.matchMedia('(max-width: 640px)')
  const applyWidth = () => {
    const full = opts.mode === 'page' || narrow.matches
    overlay.style.padding = full ? '0' : '24px'
    dialog.style.maxWidth = full ? 'none' : '640px'
    dialog.style.borderRadius = full ? '0' : '12px'
    dialog.style.maxHeight = full ? '100dvh' : '90dvh'
    dialog.style.minHeight = full ? '100dvh' : '0'
  }
  applyWidth()
  narrow.addEventListener('change', applyWidth)

  // Клик по подложке — но только по ней самой: клик внутри диалога всплывает сюда же.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeWidget()
  })

  const entry: Mounted = { frame, opts, handlers: {}, overlay }
  // Ловушка фокуса. Полноценно замкнуть Tab внутри модалки нельзя: когда фокус ушёл
  // в форму, события клавиатуры живут в ДРУГОМ документе и нам не видны. Зато виден
  // focusin в своём: как только фокус выпал наружу (Tab с последнего поля формы),
  // возвращаем его на кнопку закрытия.
  document.addEventListener('focusin', (event) => {
    if (openWidgetEntry !== entry) return
    if (!overlay.contains(event.target as Node)) close.focus()
  })
  return entry
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
  lockScroll()
  ;(entry.overlay!.querySelector('button') as HTMLButtonElement | null)?.focus()
  return handleOf(entry, closeWidget)
}

function createButton(opts: MountOptions) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = opts.label ?? DEFAULT_LABEL
  button.style.position = 'fixed'
  button.style.bottom = '24px'
  if (opts.position === 'bottom-left') button.style.left = '24px'
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
}

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

// --- Сообщения фрейма --------------------------------------------------------
//
// Единый слушатель на все фреймы страницы: их может быть несколько, и заводить
// подписку на каждый незачем. Свой фрейм узнаём по contentWindow, а не по
// придуманному идентификатору, — сравнение работает без договорённостей с фреймом.
window.addEventListener('message', (event: MessageEvent) => {
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
      // ей нельзя: форма из двух вопросов схлопнула бы фрейм до своей высоты.
      if (entry.opts.mode !== 'page') entry.frame.style.height = msg.height + 'px'
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
      return
    case 'redirect':
      // Переход после отправки: внутри фрейма он увёл бы человека в сайт внутри сайта,
      // поэтому его делает хозяин страницы. Ссылка проверена ещё раз — она прилетела
      // через границу фрейма и уходит в location чужого сайта.
      if (entry.opts.redirect !== 'frame' && isHttpUrl(msg.url)) window.location.assign(msg.url)
      return
  }
})

// Декларативный путь: сниппет-однотегович вставляет форму на место самого скрипта.
// document.currentScript работает и с async (в отличие от модулей), поэтому парный
// div на чужой странице не нужен — одна строка в буфере обмена, нечего перепутать.
if (current && current.parentNode) {
  const opts = optionsFromAttrs(current)
  if (opts?.mode === 'widget') {
    createButton(opts)
  } else if (opts) {
    const slot = document.createElement('div')
    current.parentNode.insertBefore(slot, current)
    mount(slot, opts)
  }
}

// Императивный путь — для приложений, где контейнер появляется после загрузки, а
// форма открывается по событию приложения (онбординг в SPA), а не по клику в разметке.
//
// Один и тот же файл на странице может выполниться дважды (два сниппета — два тега с
// одним src), поэтому глобал заводится идемпотентно: второй проход не должен обнулять
// подписки первого.
declare global {
  interface Window {
    Trillix?: {
      mount(target: Element, opts: MountOptions): EmbedHandle | null
      open(opts: MountOptions, from?: HTMLElement | null): EmbedHandle | null
      close(): void
    }
  }
}
window.Trillix = window.Trillix ?? { mount, open, close: closeWidget }
