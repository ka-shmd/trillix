// ПРОБА ЭТАПА 14.0. Текстовая поверхность строки полотна на contenteditable —
// замена <textarea> в BlockRow. Проба проверяет три вещи (демо-критерий 14.0):
// клавиатурный поток фазы 13 цел, каретка переживает ре-рендер полотна на каждый
// символ (риск TD-32 × contenteditable, §6 спеки), полотно из 30 строк не тормозит.

import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react'
import { chords } from '../shortcuts'
import { plainText, spansFromDom, spansToDom, toggleMark, setColor, type Span } from './spans'
import { richCaret, selectionRange, setCaret, setSelection } from './richCaret'
import './richLine.css'

// Цвет пробы: одна значимая марка, чтобы проверить механику «марка со значением».
// В фазе цвет выбирает автор (свободный `#rrggbb`, ADR §10).
const SPIKE_COLOR = '#c026d3'

export interface RichLineProps {
  // Плоский текст из стора. Богатый текст в контракте появится этапом 14.1 — до тех
  // пор марки живут только в этой поверхности и внешнюю правку (undo, смену типа) не
  // переживают. Ограничение ПРОБЫ, а не конструкции: спанам некуда сохраняться.
  value: string
  placeholder?: string
  className?: string
  // Каретка приходит в координатах плоского текста — ровно то, что раньше давал
  // selectionStart у textarea, поэтому инлайн-слеш в BlockRow не переписывается.
  onChange: (value: string, caret: number) => void
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
  const spans = useRef<Span[]>(value ? [{ t: value }] : [])
  // lastPlain — что мы сами в последний раз отдали наружу. Отличие пришедшего value от
  // него и означает «правку сделали снаружи» (undo/redo, смена типа блока, ремаунт).
  const lastPlain = useRef(value)
  const composing = useRef(false)

  // Поверхность НЕуправляемая: React владеет узлом, но не его детьми. Управляемый
  // contenteditable перерисовывался бы на каждый символ и ронял каретку — а полотно и
  // без того ре-рендерится целиком на каждый набранный символ (TD-32).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (value === lastPlain.current && (el.textContent ?? '') === value) return
    // Правка пришла снаружи: печатаем заново. Марки при этом теряются — см. комментарий
    // к value: спанам пока некуда сохраняться.
    const hadFocus = el.ownerDocument.activeElement === el
    const at = hadFocus ? richCaret(el).text().caret : 0
    spans.current = value ? [{ t: value }] : []
    lastPlain.current = value
    spansToDom(el, spans.current)
    if (hadFocus) setCaret(el, Math.min(at, value.length))
  }, [value])

  // commit — единственный путь наружу: сериализуем поверхность в модель и отдаём
  // плоский текст с позицией каретки.
  function commit(): void {
    const el = ref.current
    if (!el) return
    spans.current = spansFromDom(el)
    const plain = plainText(spans.current)
    lastPlain.current = plain
    onChange(plain, richCaret(el).text().caret)
  }

  // apply — команда форматирования: над МОДЕЛЬЮ, не над DOM. Выделение восстанавливается
  // по смещениям в плоском тексте: DOM-позиции после разрезания спанов другие, а
  // смещения — те же, поэтому выделение переживает наложение марки.
  function apply(f: (s: Span[], from: number, to: number) => Span[]): void {
    const el = ref.current
    if (!el) return
    const sel = selectionRange(el)
    if (!sel) return
    spans.current = f(spansFromDom(el), sel.from, sel.to)
    spansToDom(el, spans.current)
    setSelection(el, sel.from, sel.to)
    // Плоский текст форматирование не меняет — стор трогать незачем, и это удобно:
    // марка не порождает шага истории до тех пор, пока её некуда сохранять (проба).
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    // Форматирование — до потока строки. Mod+B гасим ЯВНО: иначе браузер сам применит
    // своё жирное внутри contenteditable и вставит теги мимо модели.
    if (chords.bold(e)) {
      e.preventDefault()
      return apply((s, from, to) => toggleMark(s, from, to, 'b'))
    }
    if (chords.spikeColor(e)) {
      e.preventDefault()
      return apply((s, from, to) => setColor(s, from, to, SPIKE_COLOR))
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
        // Между compositionstart и compositionend поверхность не трогаем вовсе: ресинк
        // посреди составного ввода рвёт набор (кириллица через IME, диакритика, эмодзи).
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
        // Вставка в v1 приводится к plain text (§3.2 спеки): разбор чужого HTML —
        // самостоятельная задача, в демо-критерий фазы не входит. Строка однострочная,
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
