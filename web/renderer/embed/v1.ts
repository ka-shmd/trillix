// Загрузчик встроенной формы. Раздаётся как /embed/v1.js и живёт на чужих сайтах,
// откуда его не отозвать: НОМЕР ВЕРСИИ В ИМЕНИ — ЭТО КОНТРАКТ. Правки сюда — только
// обратно совместимые; всё, что ломает вставленные сниппеты, обязано стать v2.js
// (design/embed.md §3).
//
// У сниппета ДВЕ формы, и обе обязаны работать вечно.
//
// Однотеговая — скрипт сам вставляет фрейм на своё место:
//   <script src="https://f.trillix.ru/embed/v1.js" data-trillix-form="opros" async></script>
//   <script src="…/v1.js" data-trillix-widget="opros" data-label="Оставить заявку" async></script>
//   <script src="…/v1.js" data-trillix-form="opros" data-mode="page" async></script>
//
// Двухтеговая — фрейм написан в разметке, загрузчик его усыновляет (`loadEmbeds`):
//   <iframe data-trillix-src="…/r/opros?embed=block" width="100%" height="520"></iframe>
//   <script async src="https://f.trillix.ru/embed/v1.js"></script>
// Место фрейма в этой форме держит разметка, поэтому вставка не прыгает при загрузке,
// а сам фрейм виден автору — его можно двигать и стилизовать, не трогая наш код.
// Тот же обход подбирает фрейм, построенный чужим редактором по «ссылке для вставки»
// (Notion, Ghost, Canva): адрес ему не меняют, но высота начинает следовать за формой,
// как только на страницу добавлен тег загрузчика.
//
// Стили везде назначаются через CSSOM (`el.style.x = …`), а не атрибутом style: на
// сайте со строгой CSP без 'unsafe-inline' атрибут был бы отброшен и виджет остался
// бы неотличим от обычного div, тогда как свойства CSSOM политика не трогает.

import {
  DEFAULT_HEIGHT,
  DEFAULT_LABEL,
  DEFAULT_OPEN_DELAY,
  DEFAULT_OPEN_SCROLL,
  defaultWidth,
  frameAdoption,
  frameSrc,
  isHttpUrl,
  optionsFromAttrs,
  readFrameMessage,
  scriptOrigin,
  selfScrollWidget,
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

/**
 * createFrame — фрейм формы. `innerScroll` — прокручивает ли фрейм себя сам.
 *
 * Флаг нужен ровно панели виджета (`selfScrollWidget`): там форма прокручивается
 * ВНУТРИ фрейма, а `scrolling="no"` отнял бы у неё эту возможность вовсе — длинная
 * форма осталась бы обрезанной по нижнему краю панели.
 */
function createFrame(opts: MountOptions, innerScroll = false): HTMLIFrameElement {
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
    if (opts.dynamicHeight !== false && !innerScroll) frame.scrolling = 'no'
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
 * loadEmbeds — взять под управление фреймы страницы, ведущие на наш origin: и
 * размеченные `data-trillix-src` (двухтеговый сниппет), и построенные чужим
 * редактором по «ссылке для вставки».
 *
 * Публичный метод (`Trillix.loadEmbeds()`), а не только внутренний вызов: фрейм может
 * появиться после загрузки — карточка товара в SPA, вкладка, аккордеон, — и поднять
 * его тогда некому. Тот же метод и у Tally, и по той же причине.
 *
 * Повторный вызов безопасен: усыновлённому фрейму проставлен `src`, и селектор его
 * больше не видит.
 */
function loadEmbeds(): void {
  for (const frame of Array.from(document.querySelectorAll('iframe'))) adoptFrame(frame)
}

/**
 * adoptFrame — чужой по происхождению узел становится нашей вставкой.
 *
 * РЕГИСТРАЦИЯ В РЕЕСТРЕ ОБЯЗАТЕЛЬНА, и это не бухгалтерия: `onFrameMessage` ищет
 * отправителя среди `mounted`, и фрейм мимо реестра не получил бы ни подстройки
 * высоты, ни подтяжки страницы при смене шага — форма молча осталась бы ростом в
 * атрибут `height`.
 */
function adoptFrame(frame: HTMLIFrameElement): void {
  if (mounted.some((m) => m.frame === frame)) return
  // ДВА ИСТОЧНИКА АДРЕСА, и разница между ними принципиальная. `data-trillix-src` —
  // наш сниппет: адрес ещё не тронут, его ставим мы. Обычный `src` — фрейм, который
  // построил чужой редактор по «ссылке для вставки» (Notion, Ghost, Canva): он уже
  // грузится, и трогать его адрес нельзя — перезапись перезагрузила бы форму, стерев
  // набранное. Оттуда берём только настройки, ради подстройки высоты.
  const declared = frame.getAttribute('data-trillix-src')
  const address = declared ?? frame.getAttribute('src')
  const adoption = frameAdoption(ORIGIN, address, frame, window.location.search)
  if (adoption === null) return

  if (declared !== null && frame.getAttribute('src') === null) {
    frame.src = adoption.src
    if (frame.title === '') frame.title = 'Форма'
    // Высоту у блока ведёт содержимое, поэтому внутренний скролл там лишний — то же
    // правило, что у собранного нами фрейма (`createFrame`). У страницы фрейм ростом
    // с вьюпорт и скроллится сам.
    if (adoption.opts.mode !== 'page' && adoption.opts.dynamicHeight !== false) {
      frame.scrolling = 'no'
    }
    // «Страница» запирает прокрутку хозяина: за фиксированным фреймом прокручивать
    // нечего, а незапертая страница уезжала бы колесом поверх формы. Замок живёт,
    // пока живёт вставка, — снимать его закрытию виджета не даёт `pageMounted`.
    if (adoption.opts.mode === 'page') {
      pageMounted = true
      lockScroll()
    }
  }
  mounted.push({ frame, opts: adoption.opts, handlers: {} })
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
  // ПАНЕЛЬ В УГЛУ ПРОКРУЧИВАЕТ ФОРМУ ВНУТРИ ФРЕЙМА, окно по центру — снаружи собой
  // (решение владельца 2026-08-28, `selfScrollWidget`). Разница нужна бейджу
  // площадки: он прижат к низу панели, а низ у фрейма есть только тогда, когда фрейм
  // перестал расти вслед за содержимым. Здесь из этого следуют три строки — колонка
  // flex, обрезка вместо прокрутки и `min-height: 0` у фрейма, — и каждая обязательна:
  // без первых двух панель прокручивалась бы дважды, без третьей фрейм не ужался бы
  // под потолок панели (у заменяемого элемента автоминимум равен его высоте).
  const pinned = selfScrollWidget(opts)

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
  dialog.style.overflowY = pinned ? 'hidden' : 'auto'
  if (pinned) {
    dialog.style.display = 'flex'
    dialog.style.flexDirection = 'column'
  }
  dialog.style.boxShadow = '0 24px 64px rgba(15, 23, 42, 0.35)'
  // Полоса прокрутки панели — тонкая и приглушённая: системная широкая полоса в окне
  // шириной 376 съедает край формы и выглядит как часть чужого сайта, а не наша.
  // Свойствами, а не псевдоэлементом `::-webkit-scrollbar`: вставить правило в чужой
  // документ нам нечем (стили назначаются только через CSSOM), а эта пара
  // поддерживается и в Firefox, и в свежем Chrome. Где не поддерживается — остаётся
  // системная полоса, то есть сегодняшний вид.
  dialog.style.setProperty('scrollbar-width', 'thin')
  dialog.style.setProperty('scrollbar-color', 'rgba(15, 23, 42, 0.25) transparent')

  // КРЕСТИК СТОИТ ВНУТРИ ПАНЕЛИ, В ЕЁ ПРАВОМ ВЕРХНЕМ УГЛУ (решение владельца
  // 2026-08-28), но живёт по-прежнему НА ОБЁРТКЕ, а не в самой панели, и это не
  // вёрстка ради вёрстки: панель бывает скролл-контейнером (окно по центру), и
  // лежащий внутри неё крестик уезжал бы вверх вместе с содержимым — прокрутивший
  // форму человек остался бы без способа её закрыть, кроме Esc, о котором он не знает.
  // Обёртка не скроллится никогда, поэтому кнопка стоит на месте в обеих геометриях.
  //
  // ПЛАШКИ ПОД ГЛИФОМ НЕТ (решение владельца 2026-08-28): белый круг с тенью нужен был
  // кнопке, висевшей ПОЛОВИНОЙ над чужой страницей — внутри панели ему не на чем
  // читаться, кроме самой формы, и он выглядит вторым элементом управления над ней.
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', 'Закрыть форму')
  close.textContent = '×'
  close.style.position = 'absolute'
  close.style.width = '28px'
  close.style.height = '28px'
  close.style.border = '0'
  close.style.background = 'transparent'
  close.style.color = '#0f172a'
  close.style.fontSize = '22px'
  close.style.lineHeight = '1'
  close.style.cursor = 'pointer'
  close.style.zIndex = '2'
  close.addEventListener('click', closeWidget)

  // ОБЁРТКА нужна ради крестика: она не скроллится, поэтому кнопка стоит на месте,
  // пока длинная форма прокручивается. Ничего не прячет и задаёт ширину, панель
  // занимает её целиком.
  const panel = document.createElement('div')
  panel.style.position = 'relative'
  panel.style.width = '100%'
  panel.style.pointerEvents = 'auto'

  const frame = createFrame(opts, pinned)
  // Фрейм ужимается до потолка панели, а не растягивает её собой: высота приезжает
  // сообщением `resize` и остаётся основой flex, поэтому короткая форма по-прежнему
  // даёт панель по себе, а длинная упирается в потолок и прокручивается внутри.
  if (pinned) frame.style.minHeight = '0'
  dialog.appendChild(frame)
  panel.appendChild(dialog)
  panel.appendChild(close)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const narrow = window.matchMedia('(max-width: 640px)')
  const place = () => {
    const full = opts.mode === 'page' || narrow.matches
    // ЦЕНТР — ОКНО, А НЕ УГОЛ: то же полотно, только выравнивание по обеим осям
    // посередине. Своей ветки раскладки ему по-прежнему не нужно — здесь их разделяют
    // ровно два значения flex; расходятся они выше (ширина и `pinned`), а не тут.
    const centered = corner === 'center'
    const top = corner === 'top-right' || corner === 'top-left'
    const left = corner === 'bottom-left' || corner === 'top-left'

    overlay.style.padding = full ? '0' : '24px'
    // Раскладка одна на все положения: flex-контейнер во весь вьюпорт и два
    // выравнивания. Позиционировать панель координатами было бы то же самое, но в
    // пяти ветках вместо двух строк.
    overlay.style.alignItems = full || centered ? 'center' : top ? 'flex-start' : 'flex-end'
    overlay.style.justifyContent = full || centered ? 'center' : left ? 'flex-start' : 'flex-end'

    // Умолчание ширины — по расположению: окно по центру шире панели в углу
    // (`defaultWidth`). Атрибут `data-width` его перебивает, как и раньше.
    panel.style.maxWidth = full ? 'none' : (opts.width ?? defaultWidth(corner)) + 'px'
    panel.style.height = full ? '100%' : 'auto'
    dialog.style.borderRadius = full ? '0' : '12px'
    // ПАНЕЛЬ НИЖЕ ВЬЮПОРТА, а не во всю его высоту (правка владельца 2026-08-16):
    // окно, растянутое от края до края, читается как модалка — ровно то, чем виджет
    // перестал быть. 680 — второй подход после 560: та высота оказалась мала под
    // форму из нескольких вопросов. Длинная форма прокручивается внутри: в панели у
    // угла — самим фреймом, в окне по центру — панелью (`pinned`).
    dialog.style.maxHeight = full ? '100dvh' : 'min(680px, calc(100dvh - 48px))'
    dialog.style.minHeight = full ? '100dvh' : '0'
  }
  // Крестик стоит в одном месте при любой геометрии — внутри правого верхнего угла
  // панели, — поэтому его положение и не пересчитывается вместе с ней.
  close.style.top = '12px'
  close.style.right = '12px'
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
// Кнопка при этом остаётся, если она вообще есть: закрывший форму человек должен иметь
// способ вернуться. У вставки без своей кнопки этот способ — элемент сайта, к которому
// её прицепил владелец.
function armTrigger(opts: MountOptions, button: HTMLButtonElement | null) {
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
    const passed = scrollable <= 0 ? 100 : (window.scrollY / scrollable) * 100
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
    // НАСТРОЙКИ ЧИТАЮТСЯ С САМОГО ЭЛЕМЕНТА: с 2026-08-28 кабинет печатает их
    // атрибутами на кнопке сайта (расположение, ширина, затемнение), и без разбора
    // форма открывалась бы с умолчаниями — то есть не так, как автор её настроил.
    // Запасной вариант оставлен для кнопок, размеченных до этого одним атрибутом.
    const opts = optionsFromAttrs(trigger) ?? { form, mode: 'widget' as const }
    open({ ...opts, mode: 'widget' }, trigger as HTMLElement)
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
    // СВОЯ КНОПКА — ТОЛЬКО У СТАРЫХ ВСТАВОК. Сниппет кабинета с 2026-08-28 несёт
    // `data-button="none"` и открывается элементом сайта (`data-trillix-open`) или
    // вызовом из кода; тег скрипта в этой форме нужен ради автооткрытия. Вставки,
    // стоящие на чужих сайтах с прошлых месяцев, атрибута не несут — им кнопка
    // по-прежнему рисуется, иначе форма разом стала бы на них недоступной.
    armTrigger(opts, opts.button === false ? null : createButton(opts))
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
      /** Поднять фреймы `data-trillix-src`, появившиеся после загрузки страницы. */
      loadEmbeds(): void
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
  // Фреймы второй формы сниппета ищет ПЕРВЫЙ экземпляр — реестр и подписки живут
  // там; второй только просит его посмотреть ещё раз. Осторожно, через `?.`: первым
  // мог оказаться загрузчик соседнего контура (страница с формами двух доменов), и
  // метода этого у него может не быть вовсе.
  prior.loadEmbeds?.()
} else {
  listen()
  window.Trillix = { mount, open, close: closeWidget, loadEmbeds, attach }
  if (current) attach(current)
  scanEmbeds()
}

/**
 * scanEmbeds — обход фреймов двухтеговой вставки на старте.
 *
 * Загрузчик стоит с `async`, то есть выполняется КОГДА УГОДНО относительно разбора
 * документа: фрейм, написанный ниже по странице, в этот момент может ещё не
 * существовать. Поэтому обход повторяется по `DOMContentLoaded` — иначе вставка
 * поднималась бы через раз, в зависимости от скорости сети.
 */
function scanEmbeds(): void {
  loadEmbeds()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadEmbeds, { once: true })
  }
}
