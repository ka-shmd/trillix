import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { documentFromPath } from './features/form/consent.ts'
import { createHostBridge, readEmbed, type HostBridge } from './features/form/embed.ts'
import './index.css'
// Общие стили полей формы (rf-*) — единый источник с кабинетом, см. web/shared/fields/fields.css.
import '@fields/fields.css'

// Встраивание (фаза 20) решается ДО первой отрисовки: вид зависит от атрибута на
// <html>, и ставить его из эффекта значило бы показать чужому сайту кадр обычной
// страницы с её десктопными полями.
// Путь страницы отмены. Один и тот же у Go (он отдаёт оболочку) и здесь — расходиться
// им нельзя: разъехавшись, страница получила бы оболочку и не получила экрана.
const CANCEL_PATH = '/cancel/'

const embed = readEmbed(window.location.search)
if (embed) {
  document.documentElement.dataset.embed = embed.mode
  if (embed.transparent) document.documentElement.dataset.embedBg = 'transparent'
  if (embed.alignLeft) document.documentElement.dataset.embedAlign = 'left'
  if (embed.selfScroll) document.documentElement.dataset.embedScroll = 'frame'
}

// Мост заводится, только если мы действительно во фрейме. Вид — по параметру
// (форму с ?embed=block можно открыть прямой ссылкой и посмотреть глазами), а вот
// слать сообщения самому себе бессмысленно, и, что важнее, ThankYou по наличию
// моста решает, кто делает переход после отправки: хост или мы сами.
// `redirect=frame` мост не отменяет (высота и шаги хосту по-прежнему нужны) — он
// меняет только того, кто исполняет переход после отправки, см. ThankYou.
const bridge: HostBridge | null =
  embed && window.parent !== window
    ? createHostBridge(embed.mode, (msg) => window.parent.postMessage(msg, '*'))
    : null

// СТРАНИЦА ОТМЕНЫ ЗАПИСИ — не форма, и решается это ДО первой отрисовки (фаза 27).
// Ветка здесь, а не в App: тот первым же хуком идёт грузить форму по slug'у, которого
// на этом адресе нет вовсе.
//
// Экран уезжает отдельным чанком (префикс cancel/, свой бюджет в check-bundle):
// качает его только тот, кто пришёл отменять, а у формы запаса до порога меньше
// килобайта. Импорт обязан остаться ДИНАМИЧЕСКИМ — обычный вернёт экран в общий
// бандл, и заметит это только замер сборки.
const cancelToken = window.location.pathname.startsWith(CANCEL_PATH)
  ? window.location.pathname.slice(CANCEL_PATH.length)
  : ''

// Страница документа согласия (0069) — тоже не форма и тоже своим чанком (document/):
// её открывает только тот, кто решил прочитать документ. Импорт обязан остаться
// динамическим — по той же причине, что у страницы отмены.
const documentPage = documentFromPath(window.location.pathname)

const root = createRoot(document.getElementById('root')!)
if (documentPage !== null) {
  void import('./features/document/DocumentScreen.tsx').then(({ default: DocumentScreen }) => {
    root.render(
      <StrictMode>
        <DocumentScreen slug={documentPage.slug} kind={documentPage.kind} search={window.location.search} />
      </StrictMode>,
    )
  })
} else if (cancelToken !== '') {
  void import('./features/cancel/CancelScreen.tsx').then(({ default: CancelScreen }) => {
    root.render(
      <StrictMode>
        <CancelScreen token={cancelToken} />
      </StrictMode>,
    )
  })
} else {
  root.render(
    <StrictMode>
      <App bridge={bridge} embed={embed} />
    </StrictMode>,
  )
}
