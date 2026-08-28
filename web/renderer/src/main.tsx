import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { createHostBridge, readEmbed, type HostBridge } from './features/form/embed.ts'
import './index.css'
// Общие стили полей формы (rf-*) — единый источник с кабинетом, см. web/shared/fields/fields.css.
import '@fields/fields.css'

// Встраивание (фаза 20) решается ДО первой отрисовки: вид зависит от атрибута на
// <html>, и ставить его из эффекта значило бы показать чужому сайту кадр обычной
// страницы с её десктопными полями.
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App bridge={bridge} embed={embed} />
  </StrictMode>,
)
