import { useId } from 'react'

import { type EmbedMode } from './embedSnippet'

// Миниатюры видов вставки: окно браузера, в котором форма стоит по-разному. Кнопки
// выбора были подписаны словами («Блоком», «Виджетом», «Страницей») и объяснялись
// строкой текста — картинка объясняет то же самое быстрее, а разница между видами
// как раз пространственная.
//
// Инлайн-SVG, а не файлы: CSP прода режет чужие источники, а свой ассет тут не нужен —
// это десяток прямоугольников. Цвета — токенами (`fill-muted`, `fill-primary/25`), так
// что миниатюра поедет за темой вместе с остальным кабинетом.
//
// aria-hidden: смысл несёт подпись под миниатюрой, а не она сама.
export function EmbedModeArt({ mode, className }: { mode: EmbedMode; className?: string }) {
  // Свой clipPath на каждый экземпляр: три миниатюры стоят рядом, и общий id
  // означал бы, что все три обрезаются по первому.
  const clip = useId()

  return (
    <svg viewBox="0 0 200 150" className={className} aria-hidden focusable="false">
      <g clipPath={`url(#${clip})`}>
        <rect width="200" height="150" className="fill-background" />
        {/* Шапка окна с тремя кружками — узнаваемый признак «это сайт». */}
        <rect width="200" height="16" className="fill-muted" />
        <circle cx="10" cy="8" r="2" className="fill-muted-foreground/30" />
        <circle cx="18" cy="8" r="2" className="fill-muted-foreground/30" />
        <circle cx="26" cy="8" r="2" className="fill-muted-foreground/30" />
        {mode === 'block' && <BlockArt />}
        {mode === 'widget' && <WidgetArt />}
        {mode === 'page' && <PageArt />}
      </g>
      <rect x="0.5" y="0.5" width="199" height="149" rx="6" className="fill-none stroke-border" />
      <defs>
        <clipPath id={clip}>
          <rect width="200" height="150" rx="6" />
        </clipPath>
      </defs>
    </svg>
  )
}

// Текст чужой страницы: заголовок потемнее, строки посветлее.
function PageText({ y }: { y: number }) {
  return (
    <>
      <rect x="16" y={y} width="72" height="7" rx="3.5" className="fill-muted-foreground/35" />
      <rect x="16" y={y + 15} width="126" height="4" rx="2" className="fill-muted-foreground/15" />
      <rect x="16" y={y + 24} width="112" height="4" rx="2" className="fill-muted-foreground/15" />
    </>
  )
}

// Блоком: форма стоит в потоке страницы, текст продолжается под ней.
function BlockArt() {
  return (
    <>
      <PageText y={30} />
      <rect x="16" y={72} width="112" height="42" rx="4" className="fill-primary/25" />
      <rect x="16" y={124} width="126" height="4" rx="2" className="fill-muted-foreground/15" />
      <rect x="16" y={133} width="92" height="4" rx="2" className="fill-muted-foreground/15" />
    </>
  )
}

// Виджетом: страница живёт своей жизнью, форма всплывает в углу поверх неё.
function WidgetArt() {
  return (
    <>
      <PageText y={30} />
      <rect x="16" y={78} width="118" height="4" rx="2" className="fill-muted-foreground/15" />
      <rect x="16" y={87} width="98" height="4" rx="2" className="fill-muted-foreground/15" />
      <rect x="122" y={100} width="66" height="40" rx="4" className="fill-primary/25" />
    </>
  )
}

// Страницей: форма занимает окно целиком, чужого содержимого не остаётся.
function PageArt() {
  return <rect x="10" y={26} width="180" height="114" rx="4" className="fill-primary/25" />
}
