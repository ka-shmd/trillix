// Текстовая поверхность строки полотна (фаза 14, этап 14.3): contenteditable вместо
// <textarea>. Всё, что было построено фазой 13 вокруг строки — клавиатурный поток,
// фокус-движок, инлайн-слеш, — не переписывалось: поток говорит с поверхностью через
// адаптер каретки (`caret.ts`), а слеш — через `text()` того же адаптера.
//
// Три решения, каждое куплено дефектом (§3.2 `docs/DESIGN-rich-text.md`):
//   1. Поверхность НЕуправляемая. React владеет узлом, но не его детьми: управляемый
//      contenteditable перерисовывался бы на каждый символ и ронял каретку, а полотно
//      и без того ре-рендерится целиком на каждый набранный символ (TD-32).
//   2. Ресинк из стора — только на ВНЕШНЮЮ правку (undo/redo, смена типа, ремаунт),
//      и распознаётся сравнением по значению: свежий массив с тем же содержимым
//      правкой не является. Иначе набор символа стирал бы разметку строки.
//   3. Между compositionstart и compositionend поверхность не трогаем вовсе — ресинк
//      посреди составного ввода рвёт набор (IME, диакритика).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'
import { MARKS, type Mark, type Span, plainText, sameRichText } from '@entities/formSchema'
import { chords, markChord } from './shortcuts'
import {
  hasMarkThroughout,
  hrefThroughout,
  setBg,
  setColor,
  setHref,
  spansFromDom,
  spansToDom,
  toggleMark,
} from './richText'
import { richCaret, selectionRange, selectionRect, setCaret, setSelection } from './richCaret'
import { FormatBar } from './FormatBar'
import { lockScroll } from './scrollLock'
import './richLine.css'

// Снимок выделения, над которым висит панель форматирования.
interface Sel {
  from: number
  to: number
  rect: DOMRect
  active: ReadonlySet<Mark>
  href?: string
}

// Сравнение снимков по значению. `rect` сравнивается по четырём числам: DOMRect каждый
// раз новый объект, но координаты у неподвижного выделения те же.
const sameSel = (a: Sel | null, b: Sel): boolean =>
  a !== null &&
  a.from === b.from &&
  a.to === b.to &&
  a.href === b.href &&
  a.active.size === b.active.size &&
  [...b.active].every((m) => a.active.has(m)) &&
  a.rect.x === b.rect.x &&
  a.rect.y === b.rect.y &&
  a.rect.width === b.rect.width &&
  a.rect.height === b.rect.height

export interface RichLineProps {
  // Богатый текст блока из стора — источник правды между правками.
  value: Span[]
  placeholder?: string
  // Доступное имя строки — отдельно от видимой подсказки и НЕ равно ей: у контентной
  // строки подсказка появляется только под фокусом (иначе полотно пестрит серым), а
  // имя, которое то есть, то нет, для скринридера равно отсутствию имени. Пока строка
  // была <textarea>, имя давал `placeholder` — contenteditable такой любезности не
  // делает, и до этой строки у поверхности не было имени вовсе.
  label?: string
  className?: string
  // Каретка приходит в координатах ПЛОСКОГО текста — ровно то, что раньше давал
  // selectionStart у textarea, поэтому инлайн-слеш в BlockRow не переписывается.
  onChange: (value: Span[], caret: number) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  onFocus: () => void
  onBlur: (e: FocusEvent<HTMLElement>) => void
  elRef: (el: HTMLDivElement | null) => void
}

export function RichLine({
  value,
  placeholder,
  label,
  className,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  elRef,
}: RichLineProps) {
  const ref = useRef<HTMLDivElement>(null)
  // last — что мы сами в последний раз отдали наружу. Отличие пришедшего value от него
  // (ПО ЗНАЧЕНИЮ) и означает «правку сделали снаружи».
  const last = useRef<Span[]>(value)
  const composing = useRef(false)
  // Выделение, над которым висит панель форматирования. Держится в СОСТОЯНИИ, а не
  // читается из живого Selection в момент нажатия: поле адреса ссылки берёт фокус, и
  // живое выделение к тому моменту уже схлопнуто.
  // Всё про выделение считается ОДИН раз, в момент его изменения, и живёт в состоянии:
  // читать `ref.current` во время рендера нельзя (правило React), да и незачем — панели
  // нужен снимок, а не живой DOM.
  const [sel, setSel] = useState<Sel | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)

  // Выделение отслеживается на документе: внутри contenteditable его меняют и мышь, и
  // клавиатура, и события у них разные — один `selectionchange` покрывает оба.
  //
  // `known` — спаны, которые вызывающий только что записал в DOM (команда
  // форматирования). Без них пришлось бы читать поверхность второй раз за тот же кадр.
  const syncSelection = useCallback((known?: Span[]) => {
    const el = ref.current
    if (!el || el.ownerDocument.activeElement !== el) return
    const range = selectionRange(el)
    const rect = selectionRect(el)
    if (!range || !rect) {
      setSel(null)
      setLinkOpen(false)
      return
    }
    const spans = known ?? spansFromDom(el)
    const next = {
      ...range,
      rect,
      // По MARKS, а не перечислением четырёх: новая марка не должна требовать правки
      // ни панели, ни этого места.
      active: new Set(MARKS.filter((m) => hasMarkThroughout(spans, range.from, range.to, m))),
      href: hrefThroughout(spans, range.from, range.to),
    }
    // Тот же снимок — тот же объект. Это не микрооптимизация: выборщик цвета зовёт
    // команду форматирования на каждом кадре перетаскивания, а диапазон и марки при
    // этом не меняются вовсе. Свежий объект каждый раз означал бы ре-рендер панели,
    // пересчёт позиции поповера и перезапуск обоих эффектов ниже — 60 раз в секунду
    // ради снимка, который не изменился.
    setSel((prev) => (sameSel(prev, next) ? prev : next))
  }, [])

  // Обоим эффектам ниже важен только факт «панель открыта», а не сам снимок: без этого
  // они снимали бы и вешали слушателей на каждое изменение выделения.
  const panelOpen = sel !== null

  // Пока панель открыта, прокрутка заперта: панель стоит по координатам выделения,
  // снятым один раз, и прокрутка увезла бы текст из-под неё (решение владельца
  // 2026-07-27; альтернатива — пересчитывать позицию на каждом кадре).
  useEffect(() => {
    const el = ref.current
    if (!panelOpen || !el) return
    return lockScroll(el)
  }, [panelOpen])

  // Клик мимо строки и мимо панели закрывает панель. Отдельный слушатель нужен потому,
  // что blur самой строки этот случай не покрывает: когда открыто поле адреса, фокус уже
  // не в строке, а в поле, и её blur давно прошёл. Без этого меню ссылки оставалось
  // висеть после клика в пустоту (найдено владельцем в браузере).
  useEffect(() => {
    if (!panelOpen) return
    const doc = ref.current?.ownerDocument
    if (!doc) return
    const onDown = (e: Event) => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (ref.current?.contains(t)) return
      if (t instanceof Element && t.closest('[data-format-bar]')) return
      setSel(null)
      setLinkOpen(false)
    }
    doc.addEventListener('mousedown', onDown)
    return () => doc.removeEventListener('mousedown', onDown)
  }, [panelOpen])

  // Выделение меняют и мышь, и клавиатура, и события у них разные — один
  // `selectionchange` на документе покрывает оба.
  useEffect(() => {
    const doc = ref.current?.ownerDocument
    if (!doc) return
    // Обёртка, а не сама функция: слушателю браузер передаёт событие, а первый аргумент
    // `syncSelection` — это спаны.
    const onChangeSel = () => syncSelection()
    doc.addEventListener('selectionchange', onChangeSel)
    return () => doc.removeEventListener('selectionchange', onChangeSel)
  }, [syncSelection])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (sameRichText(value, last.current) && el.textContent === plainText(value)) return
    const hadFocus = el.ownerDocument.activeElement === el
    const at = hadFocus ? richCaret(el).text().caret : 0
    last.current = value
    spansToDom(el, value)
    if (hadFocus) setCaret(el, Math.min(at, plainText(value).length))
  }, [value])

  // commit — единственный путь наружу: сериализуем поверхность в модель и отдаём её
  // вместе с позицией каретки.
  function commit(): void {
    const el = ref.current
    if (!el) return
    const spans = spansFromDom(el)
    last.current = spans
    onChange(spans, richCaret(el).text().caret)
  }

  // apply — команда форматирования: над МОДЕЛЬЮ, не над DOM. Выделение восстанавливается
  // по смещениям в плоском тексте: DOM-позиции после разрезания спанов другие, а
  // смещения — те же, поэтому выделение переживает наложение марки и его видно на месте.
  //
  // Диапазон: пока фокус В СТРОКЕ, источник — живое выделение, и только оно. Снимок
  // состояния для этого не годится, хотя он всегда под рукой: он приезжает из
  // `selectionchange` через React, то есть на кадр ПОЗЖЕ нажатия, и аккорд ставил бы
  // марку на предыдущее выделение. Найдено e2e этапа 14.5: `Shift+←` трижды и `Mod+B`
  // красили один символ из трёх, а с паузами между нажатиями — два из трёх (отставание
  // ровно на столько событий, сколько React не успел свести).
  //
  // Снимок нужен в обратном случае — фокус ушёл из строки в панель (поле адреса,
  // выборщик цвета): живого выделения там уже нет, и диапазон помнит только он.
  function apply(f: (s: Span[], from: number, to: number) => Span[]): void {
    const el = ref.current
    if (!el) return
    const range = el.ownerDocument.activeElement === el ? selectionRange(el) : sel
    if (!range) return
    const spans = f(spansFromDom(el), range.from, range.to)
    spansToDom(el, spans)
    setSelection(el, range.from, range.to)
    last.current = spans
    // Плоский текст форматирование не меняет, но модель — меняет: отдаём наружу, иначе
    // разметка не доедет ни до автосейва, ни до истории отмены.
    onChange(spans, range.to)
    // Форматирование меняет и модель, и «что нажато» в панели. Пересчитываем сразу, а
    // не ждём `selectionchange`: восстановление выделения его не гарантирует. Спаны
    // отдаём готовыми — читать поверхность второй раз за кадр незачем.
    syncSelection(spans)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    // Форматирование — до потока строки. Mod+B/I/U гасим ЯВНО и останавливаем всплытие:
    //   • без preventDefault браузер сам применит своё жирное внутри contenteditable и
    //     вставит теги мимо модели;
    //   • без stopPropagation Mod+B доедет до вендоренного сайдбара shadcn (слушатель
    //     на window, `components/ui/sidebar.tsx`) и схлопнет его заодно с жирным.
    // Аккорд забирает себе только текстовая строка — в остальном кабинете Mod+B
    // по-прежнему сайдбар.
    const mark: Mark | null = markChord(e)
    if (mark) {
      e.preventDefault()
      e.stopPropagation()
      return apply((s, from, to) => toggleMark(s, from, to, mark))
    }
    // Mod+K открывает поле адреса, а не применяет значение вслепую: у ссылки есть
    // значение, и «поставить ссылку» без него — жест без результата.
    if (chords.link(e)) {
      e.preventDefault()
      e.stopPropagation()
      // Снимок обновляем ЯВНО, по живому выделению: поле адреса сейчас заберёт фокус,
      // и применять марку придётся уже по снимку — значит он обязан быть свежим. По
      // той же причине и открытие панели решает живое выделение, а не состояние: оно
      // на кадр моложе (см. `apply`).
      const el = e.currentTarget
      if (!selectionRange(el)) return
      syncSelection()
      setLinkOpen(true)
      return
    }
    onKeyDown(e)
  }

  const surface = (
    <div
      ref={(el) => {
        ref.current = el
        elRef(el)
      }}
      data-rich-line=""
      data-ph={placeholder}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      tabIndex={0}
      className={className}
      onInput={() => {
        if (composing.current) return
        commit()
      }}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
        commit()
      }}
      onPaste={(e) => {
        // Вставка приводится к plain text (§3.2 спеки, осознанная граница v1): разбор
        // чужого HTML из Word/Docs — самостоятельная задача со своим списком ловушек,
        // в демо-критерий фазы она не входит и записана в BACKLOG. Строка однострочная,
        // поэтому переносы становятся пробелами.
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ')
        if (!text) return
        e.currentTarget.ownerDocument.execCommand('insertText', false, text)
      }}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
      onBlur={(e) => {
        // Уход фокуса ИЗ строки в панель — не уход: панель гасит mousedown, но поле
        // адреса ссылки фокус берёт намеренно. Без этой проверки панель исчезала бы
        // ровно в тот момент, когда автор в неё целится.
        if (
          e.relatedTarget instanceof HTMLElement &&
          e.relatedTarget.closest('[data-format-bar]')
        ) {
          return
        }
        setSel(null)
        setLinkOpen(false)
        onBlur(e)
      }}
    />
  )

  return (
    <>
      {surface}
      {sel && (
        <FormatBar
          rect={sel.rect}
          active={sel.active}
          href={sel.href}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          // Выборщик цвета держит фокус у себя, пока автор выбирает: вернуть его в
          // строку — работа строки, она же знает диапазон, который надо подсветить
          // обратно.
          onReturnFocus={() => {
            const el = ref.current
            if (!el) return
            el.focus({ preventScroll: true })
            setSelection(el, sel.from, sel.to)
          }}
          onToggleMark={(m) => apply((s, from, to) => toggleMark(s, from, to, m))}
          onColor={(c) => apply((s, from, to) => setColor(s, from, to, c))}
          onBg={(c) => apply((s, from, to) => setBg(s, from, to, c))}
          onLink={(href) => apply((s, from, to) => setHref(s, from, to, href))}
        />
      )}
    </>
  )
}
