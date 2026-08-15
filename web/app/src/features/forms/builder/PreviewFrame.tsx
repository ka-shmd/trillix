import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import { BuilderStoreContext } from './storeContext'
import type { BuilderStore } from './store'

// ПРЕВЬЮ ЖИВЁТ В СВОЁМ ДОКУМЕНТЕ (TD-60, закрывает хвост слайса 7 фазы 22).
//
// Зачем. Автор пишет свой CSS формы, и показать результат обязано превью — иначе
// правила пишутся вслепую, а увидеть их можно только опубликовав. Но `<style>`
// автора в документе кабинета покрасил бы САМ КАБИНЕТ: классы `rf-*` носит и
// полотно редактора, а `.rf-input{display:none}` из формы погасил бы поля вокруг.
// Граница между «формой автора» и «нашим инструментом» обязана быть настоящей, а не
// договорённостью об именах, — и настоящая граница в браузере ровно одна, документ.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ КОРЕНЬ, А НЕ createPortal В ЧУЖОЙ ДОКУМЕНТ. React вешает
// обработчики на контейнер СВОЕГО корня, а событие из документа фрейма до чужого
// документа не всплывает: портал отрисовал бы превью, но клики и ввод в нём умерли
// бы молча. Заполняемость превью — свойство фазы 21, терять его нельзя, поэтому
// внутри фрейма поднимается свой корень React.
//
// Цена отдельного корня — контекст: провайдеры родителя в него не попадают. Стор
// передаётся пропом и надевается заново; больше превью ничего не просит (тариф ему
// приходит пропом с фазы 22 — как раз затем, чтобы не тянуть сюда Query).

// mirrorStyles копирует стили кабинета в документ фрейма и держит их в актуальном
// состоянии. Копирование, а не общий файл: в проде стили приезжают `<link>`, в dev
// vite инжектит их `<style>` и правит их ТЕКСТ на каждом hot-reload — узел один и
// тот же, поэтому подписка идёт и на characterData, иначе превью в dev застывало бы
// на стилях момента открытия.
//
// Полная пересборка на каждую мутацию, а не точечная: в голове десяток узлов, а
// разница «что именно изменилось» стоила бы больше, чем весь пересчёт.
function mirrorStyles(from: HTMLElement, to: HTMLElement): () => void {
  const sync = () => {
    for (const stale of Array.from(to.querySelectorAll('[data-mirrored]'))) stale.remove()
    for (const node of Array.from(from.querySelectorAll('style, link[rel="stylesheet"]'))) {
      const copy = node.cloneNode(true) as HTMLElement
      copy.setAttribute('data-mirrored', '')
      to.appendChild(copy)
    }
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(from, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

// Скелет документа фрейма. Холст красит `.rf-theme` (fields.css), поэтому фрейму
// нужно лишь дать ему растянуться на всю высоту — иначе тёмная форма получила бы
// белую полосу под собой на коротком документе.
const FRAME_RESET = `html,body{height:100%}body{margin:0}
#preview-root,#preview-root>.rf-theme{min-height:100%}`

export function PreviewFrame({
  store,
  onEscape,
  children,
}: {
  store: StoreApi<BuilderStore>
  onEscape?: () => void
  children: ReactNode
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const rootRef = useRef<Root | null>(null)
  // Пересчёт рендера ждёт готовности корня: эффект создания идёт первым, но эффект
  // отрисовки обязан повториться после него, а не только на смене children.
  const [ready, setReady] = useState(false)
  // Колбэк Esc держится в ref: слушатель ставится один раз вместе с документом
  // фрейма, а колбэк пересоздаётся каждым рендером родителя.
  const escapeRef = useRef(onEscape)
  useEffect(() => {
    escapeRef.current = onEscape
  })

  useEffect(() => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    if (!doc) return

    doc.documentElement.lang = 'ru'
    const reset = doc.createElement('style')
    reset.textContent = FRAME_RESET
    doc.head.appendChild(reset)
    const stopMirror = mirrorStyles(document.head, doc.head)

    const mount = doc.createElement('div')
    mount.id = 'preview-root'
    doc.body.appendChild(mount)

    // Esc внутри фрейма — событие СВОЕГО документа: до кабинета оно не всплывает, и
    // без этого слушателя закрытие работало бы только пока автор ни разу не кликнул
    // в форму.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escapeRef.current?.()
    }
    doc.addEventListener('keydown', onKeyDown)

    const root = createRoot(mount)
    rootRef.current = root
    setReady(true)

    return () => {
      rootRef.current = null
      setReady(false)
      doc.removeEventListener('keydown', onKeyDown)
      stopMirror()
      reset.remove()
      // Размонтирование откладывается на микрозадачу: корень фрейма может сноситься
      // во время рендера родителя (переключение режима), а синхронный unmount из
      // чужого рендера React ругает предупреждением и пропускает очистку.
      //
      // МИНА: узел `#preview-root` обязан уехать вместе с корнем. Эффект прогоняется
      // ДВАЖДЫ (StrictMode в dev), и оставленный узел не просто мусор — `FRAME_RESET`
      // тянет ему `min-height:100%` по id, то есть каждый осиротевший даёт экран
      // пустоты над формой.
      queueMicrotask(() => {
        root.unmount()
        mount.remove()
      })
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    rootRef.current?.render(
      <BuilderStoreContext.Provider value={store}>{children}</BuilderStoreContext.Provider>,
    )
  }, [ready, store, children])

  return (
    // Фрейм занимает контейнер целиком, а высоту контейнеру задаёт вьюпорт (`h-dvh`
    // у `PreviewOverlay`): фрейм не умеет расти по содержимому, и высота обязана
    // прийти сверху числом.
    <iframe ref={frameRef} title="Просмотр формы" className="block h-full w-full border-0" />
  )
}
