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

import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react'
import { type Mark, type Span, plainText, sameRichText } from '@entities/formSchema'
import { markChord } from './shortcuts'
import { spansFromDom, spansToDom, toggleMark } from './richText'
import { richCaret, selectionRange, setCaret, setSelection } from './richCaret'
import './richLine.css'

export interface RichLineProps {
  // Богатый текст блока из стора — источник правды между правками.
  value: Span[]
  placeholder?: string
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
  function apply(f: (s: Span[], from: number, to: number) => Span[]): void {
    const el = ref.current
    if (!el) return
    const sel = selectionRange(el)
    if (!sel) return
    const spans = f(spansFromDom(el), sel.from, sel.to)
    spansToDom(el, spans)
    setSelection(el, sel.from, sel.to)
    last.current = spans
    // Плоский текст форматирование не меняет, но модель — меняет: отдаём наружу, иначе
    // разметка не доедет ни до автосейва, ни до истории отмены.
    onChange(spans, sel.to)
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
    onKeyDown(e)
  }

  return (
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
      onBlur={onBlur}
    />
  )
}
