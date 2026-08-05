// Загрузчик встроенной формы. Раздаётся как /embed/v1.js и живёт на чужих сайтах,
// откуда его не отозвать: НОМЕР ВЕРСИИ В ИМЕНИ — ЭТО КОНТРАКТ. Правки сюда — только
// обратно совместимые; всё, что ломает вставленные сниппеты, обязано стать v2.js
// (design/embed.md §3).
//
// Сниппет — один тег, без парного div:
//   <script src="https://f.trillix.ru/embed/v1.js" data-trillix-form="opros" async></script>
//
// Шаг 2 фазы 20 делает блок; виджет и полноэкранный режим приезжают шагами 3–4.

import {
  DEFAULT_HEIGHT,
  frameSrc,
  isHttpUrl,
  optionsFromAttrs,
  readFrameMessage,
  scriptOrigin,
  type MountOptions,
} from './api'

interface Mounted {
  frame: HTMLIFrameElement
  opts: MountOptions
}

const mounted: Mounted[] = []

// Откуда грузиться форме — из адреса самого загрузчика: prod-local и прод раздают
// один и тот же файл с разных доменов, и захардкоженный origin увёл бы вставку на
// чужой контур.
const current = document.currentScript as HTMLScriptElement | null
const ORIGIN = current ? scriptOrigin(current.src) : ''

/**
 * mount — вставить форму блоком в указанный узел.
 *
 * Стили назначаются через CSSOM (`frame.style.x = …`), а не атрибутом style: на сайте
 * со строгой CSP без 'unsafe-inline' атрибут был бы отброшен и фрейм остался бы
 * размером по умолчанию, тогда как свойства CSSOM политика не трогает.
 */
function mount(target: Element, opts: MountOptions): HTMLIFrameElement | null {
  if (ORIGIN === '') return null
  const frame = document.createElement('iframe')
  frame.src = frameSrc(ORIGIN, opts, window.location.search)
  // Название обязательно: без него скринридер объявляет фрейм безымянным.
  frame.title = 'Форма'
  frame.style.width = '100%'
  frame.style.border = '0'
  frame.style.display = 'block'
  frame.style.height = (opts.height ?? DEFAULT_HEIGHT) + 'px'
  // Внутреннего скролла у блока нет: высоту ведёт сообщение resize, прокручивает
  // страницу сам хозяин сайта.
  frame.scrolling = 'no'
  target.appendChild(frame)
  mounted.push({ frame, opts })
  return frame
}

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
    case 'resize':
      entry.frame.style.height = msg.height + 'px'
      return
    case 'page': {
      // Смена шага меняет высоту рывком, и чужая страница уезжает: человек оказывается
      // в середине нового шага. Подтягиваем фрейм — но ТОЛЬКО если его верх ушёл выше
      // вида: иначе дёргали бы страницу под тем, кто и так всё видит.
      const rect = entry.frame.getBoundingClientRect()
      if (rect.top < 0) entry.frame.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    case 'redirect':
      // Переход после отправки: внутри фрейма он увёл бы человека в сайт внутри сайта,
      // поэтому его делает хозяин страницы. Ссылка проверена ещё раз — она прилетела
      // через границу фрейма и уходит в location чужого сайта.
      if (entry.opts.redirect !== 'frame' && isHttpUrl(msg.url)) window.location.assign(msg.url)
      return
    default:
      // ready и submit пока никого не уведомляют: подписка появится с API (шаг 4).
      return
  }
})

// Декларативный путь: сниппет-однотегович вставляет форму на место самого скрипта.
// document.currentScript работает и с async (в отличие от модулей), поэтому парный
// div на чужой странице не нужен — одна строка в буфере обмена, нечего перепутать.
if (current && current.parentNode) {
  const opts = optionsFromAttrs(current)
  if (opts) {
    const slot = document.createElement('div')
    current.parentNode.insertBefore(slot, current)
    mount(slot, opts)
  }
}

// Один и тот же файл на странице может выполниться дважды (два сниппета — два тега с
// одним src), поэтому глобал заводится идемпотентно: второй проход не должен обнулять
// подписки первого.
declare global {
  interface Window {
    Trillix?: { mount: typeof mount }
  }
}
window.Trillix = window.Trillix ?? { mount }
