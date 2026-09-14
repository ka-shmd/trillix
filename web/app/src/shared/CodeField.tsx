import { useRef, type UIEvent } from 'react'

import { highlight, type Lang, type TokenKind } from './highlight'
import { cn } from '@/lib/utils'

// ПОЛЕ КОДА С ПОДСВЕТКОЙ — ДВА СЛОЯ, ОДИН НАД ДРУГИМ (решение владельца 2026-08-28).
//
// Своя вёрстка, а не вендоренный компонент, и это отступление названо вслух
// (web/CLAUDE.md): у shadcn редактора кода нет, а библиотек тут две — сама подсветка и
// обёртка над тем же наложением. Обе делают ровно то, что ниже, и своя реализация
// обходится дешевле двух зависимостей в замороженном списке.
//
// КАК ЭТО РАБОТАЕТ. Раскрасить текст ВНУТРИ textarea нельзя — она рисует своё
// содержимое одним цветом, разметки внутри у неё не бывает. Поэтому под полем лежит
// `<pre>` с теми же символами, разложенными по `<span>`, а сама textarea делается
// прозрачной по тексту и по фону: видно нижний слой, а печатают в верхний. Каретка и
// выделение остаются у textarea — свои им покрасить нужно отдельно, иначе каретка
// станет невидимой вместе с текстом.
//
// МИНА ЗДЕСЬ ОДНА, И ОНА ГЛАВНАЯ: слои обязаны переносить строки ОДИНАКОВО. Любое
// расхождение метрик — другой шрифт, другой кегль, другой интерлиньяж, другие поля,
// другое правило переноса — разводит буквы двух слоёв, и текст «плывёт» относительно
// собственной подсветки. Поэтому все общие свойства живут одной константой LAYER, а
// рамка и фон вынесены на обёртку: рамка на слое добавила бы ему ширины, и слои
// разъехались бы уже на первой строке.
const LAYER = 'block w-full p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words'

// Цвет по виду токена. Пустая строка у `plain` — чернила полотна, а не «цвет по
// умолчанию»: отдельный класс на каждый знак препинания раздул бы разметку вдвое.
const TOKEN_COLORS: Record<TokenKind, string> = {
  tag: 'text-code-tag',
  attr: 'text-code-attr',
  string: 'text-code-string',
  comment: 'text-code-muted',
  plain: '',
}

export function CodeField({
  id,
  value,
  lang,
  rows = 8,
  maxLength,
  placeholder,
  onChange,
  className,
}: {
  id?: string
  value: string
  lang: Lang
  rows?: number
  maxLength?: number
  placeholder?: string
  onChange: (value: string) => void
  className?: string
}) {
  const back = useRef<HTMLPreElement>(null)

  // Прокрутка ведущая у textarea: скроллит её человек, нижний слой лишь повторяет.
  // Без этого длинный CSS уезжает под полем, а подсветка остаётся на первом экране.
  const sync = (e: UIEvent<HTMLTextAreaElement>) => {
    const pre = back.current
    if (!pre) return
    pre.scrollTop = e.currentTarget.scrollTop
    pre.scrollLeft = e.currentTarget.scrollLeft
  }

  return (
    <div
      className={cn(
        'border-code-border bg-code focus-within:border-ring focus-within:ring-ring/50 relative overflow-hidden rounded-lg border transition-[color,box-shadow] focus-within:ring-[3px]',
        className,
      )}
    >
      {/* aria-hidden: для скринридера поле одно — то, в котором печатают. Нижний слой
          дублировал бы весь текст вторым узлом. */}
      <pre
        ref={back}
        aria-hidden="true"
        className={cn(
          LAYER,
          'text-code-foreground pointer-events-none absolute inset-0 overflow-hidden',
        )}
      >
        <code>
          {highlight(value, lang).map((token, i) => (
            <span key={i} className={TOKEN_COLORS[token.kind]}>
              {token.text}
            </span>
          ))}
          {/* Перевод строки в конце — за последним символом текста: `<pre>` не рисует
              завершающий перенос, и без этой добавки нижний слой на строку короче
              верхнего ровно тогда, когда каретка стоит на новой пустой строке. */}
          {'\n'}
        </code>
      </pre>
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
        className={cn(
          LAYER,
          // Прозрачные буквы и фон — весь смысл верхнего слоя. Каретка и выделение
          // красятся явно: они наследуют `color`, и вместе с текстом стали бы
          // невидимыми — печатать пришлось бы вслепую.
          'caret-code-foreground selection:bg-code-foreground/25 placeholder:text-code-muted relative resize-none bg-transparent text-transparent outline-none',
        )}
      />
    </div>
  )
}
