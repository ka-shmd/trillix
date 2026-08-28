import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import {
  frameUrl,
  iframeSnippet,
  loaderTag,
  openSnippet,
  type EmbedMode,
  type SnippetOptions,
} from '../embedSnippet'
import { highlight, type TokenKind } from './highlight'
import { Button } from '@/components/ui/button'

// ПОДПИСЬ РАЗДЕЛА — ОДНА СТРОКА НА ВИД. Инструкции («в Тильде блок HTML, в WordPress
// произвольный HTML») уехали в вики (решение владельца 2026-08-28): экран отдаёт код,
// а не учит вставлять. Остаётся то, чего из самого кода не видно, — где его место и
// что он сделает с чужой страницей.
const PASTE: Record<EmbedMode, string> = {
  block: 'Вставьте этот HTML туда, где на странице должна появиться форма.',
  widget: 'Вставьте один раз на любое место страницы: угол кнопки задаёт настройка, а не разметка.',
  page: 'Вставьте на отдельную страницу — форма займёт её целиком и накроет остальное содержимое.',
}

// ЗАГОЛОВКИ РАЗДЕЛОВ — ТОГО ЖЕ КЕГЛЯ И ВЕСА, ЧТО «Встраивание» и «Опции» в колонке
// слева (30/600, решение владельца 2026-08-28): экран один, и две шкалы заголовков на
// нём читались бы как две разные страницы, сложенные рядом.
//
// Код вставки. Разложен по уровням, потому что у встраивания две несовместимые
// аудитории: владелец сайта на Тильде, которому нужно скопировать одну строку, и
// разработчик, встраивающий форму в своё приложение. Идентификаторы блоков
// появляются только на втором уровне.
export function CodePanel({
  opts,
  snippet,
}: {
  opts: SnippetOptions
  /** Готовый сниппет — тот же, что исполняется в макете (минус флаг предпросмотра). */
  snippet: string
}) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-3xl font-semibold tracking-tight">Код для вставки</h2>
        <p className="mt-1 text-sm text-code-muted">{PASTE[opts.mode]}</p>
        <CodeBlock label="Код для вставки" code={snippet} />
      </section>

      {/* ВСТАВКА БЕЗ ЗАГРУЗЧИКА — ОДИН РАЗДЕЛ, А НЕ ДВА (решение владельца 2026-08-28).
          Адрес фрейма и готовый `<iframe>` — одно и то же в разной упаковке: первый
          для редакторов, которые строят фрейм сами (Notion, Ghost, Canva), второй для
          поля «вставьте HTML». Разведённые по двум разделам, они читались как два
          разных способа, между которыми надо выбрать.

          Тег загрузчика лежит здесь же, хотя он и есть отрицание заголовка: без него
          у такой вставки фиксированная высота, и место для этой оговорки — рядом с
          тем, к чему её добавляют, а не в разделе выше. Так же устроен экран Tally.

          У ВИДЖЕТА РАЗДЕЛА НЕТ ВОВСЕ: без загрузчика нет ни кнопки, ни модалки —
          показывать нечего. У СТРАНИЦЫ нет ссылки (адрес есть, но чужой редактор всё
          равно положит форму коробкой в поток), поэтому у неё остаётся голый фрейм и
          своя оговорка про незапертую прокрутку. */}
      {opts.mode === 'block' && (
        <section>
          <h2 className="text-3xl font-semibold tracking-tight">Без загрузчика</h2>
          <p className="mt-1 text-sm text-code-muted">
            Адрес — для редакторов, которые делают фрейм сами (Notion, Ghost, Canva). Готовый тег —
            для сайта, где сторонние скрипты запрещены.
          </p>
          <CodeBlock label="Ссылка для вставки" code={frameUrl(opts)} />
          <CodeBlock label="Код без скрипта" code={iframeSnippet(opts)} />
          <p className="mt-3 text-sm text-code-muted">
            Высота у обеих фиксированная. Тег загрузчика включает подстройку под длину формы.
          </p>
          <CodeBlock label="Тег загрузчика" code={loaderTag(opts.baseUrl)} />
        </section>
      )}

      {opts.mode === 'page' && (
        <section>
          <h2 className="text-3xl font-semibold tracking-tight">Без загрузчика</h2>
          <p className="mt-1 text-sm text-code-muted">
            Для сайта, где сторонние скрипты запрещены. Прокрутка под формой не запирается.
          </p>
          <CodeBlock label="Код без скрипта" code={iframeSnippet(opts)} />
        </section>
      )}

      <section>
        <h2 className="text-3xl font-semibold tracking-tight">Из кода приложения</h2>
        <p className="mt-1 text-sm text-code-muted">
          Загрузчик заводит <code className="font-mono text-xs">window.Trillix</code> с методами{' '}
          <code className="font-mono text-xs">mount</code>,{' '}
          <code className="font-mono text-xs">open</code> и{' '}
          <code className="font-mono text-xs">close</code>.
        </p>
        <CodeBlock label="Вызов из кода" code={openSnippet(opts)} />
      </section>
    </div>
  )
}

/**
 * CodeBlock — код на экране вставки: `<pre>` с подсветкой и кнопкой копирования в
 * правом верхнем углу.
 *
 * ПОЛЕ ВВОДА ВМЕСТО КОДА БЫЛО ЛОЖЬЮ ФОРМЫ: `<textarea readonly>` выглядит местом,
 * куда пишут, и предлагает каретку там, где менять нечего. Заодно у него нужно было
 * угадывать `rows` — число строк заранее не известно (сниппет виджета короче
 * блочного, вызов из кода растёт со списком вопросов), и промах давал либо пустоту
 * под кодом, либо внутренний скролл в три строки.
 *
 * СТРОКИ ПЕРЕНОСЯТСЯ, А НЕ УЕЗЖАЮТ В ГОРИЗОНТАЛЬНЫЙ СКРОЛЛ (`break-all`): сниппет —
 * одна длинная строка с адресом, и спрятать её половину за краем значит спрятать
 * ровно то, что автор пришёл проверить. Разрыв в любом месте адрес не портит:
 * копируется он кнопкой, а не выделением.
 *
 * КНОПКА ВНУТРИ БЛОКА, А НЕ ПОД НИМ (решение владельца 2026-08-28): у блоков разной
 * высоты кнопка снизу оказывается каждый раз в новом месте, а угол — один и тот же
 * для всех. Отсюда и отступ справа у самого кода: без него длинная строка подтекала
 * бы под кнопку.
 *
 * Подсветка — своя (`highlight.ts`), токены превращаются в `<span>`; строкой разметка
 * не собирается, `dangerouslySetInnerHTML` запрещён во всём репозитории (инвариант 4).
 */
function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="relative mt-3">
      {/* tabIndex — чтобы до блока доходила клавиатура: aria-label называет его там,
          где заголовок раздела отделён от кода абзацем. */}
      <pre
        tabIndex={0}
        aria-label={label}
        className="rounded-md border border-code-border bg-code-foreground/5 py-3 pr-14 pl-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        <code>
          {highlight(code).map((token, i) => (
            <span key={i} className={TOKEN_COLORS[token.kind]}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
      <CopyButton
        text={code}
        label={`Скопировать: ${label.toLowerCase()}`}
        iconOnly
        variant="ghost"
        className="absolute top-1.5 right-1.5 text-code-muted hover:bg-code-foreground/10 hover:text-code-foreground"
      />
    </div>
  )
}

// Цвет по виду токена. Пустая строка у `plain` — чернила полотна, а не «цвет по
// умолчанию»: отдельный класс на каждый знак препинания раздул бы разметку вдвое.
const TOKEN_COLORS: Record<TokenKind, string> = {
  tag: 'text-code-tag',
  attr: 'text-code-attr',
  string: 'text-code-string',
  comment: 'text-code-muted',
  plain: '',
}

// Кнопка «скопировать» — одна на экран: куски кода здесь и ссылка встраивания в
// панели слева (у блока). Подпись и вид приходят пропами, ответ на нажатие — общий: два
// одинаковых буфера с разным поведением после клика читались бы как две разные
// кнопки. Ответ этот — И СЛОВО, И ЗНАЧОК: у кнопки без границы (ghost) смена
// подписи — единственное, что происходит на экране, и галочка делает её заметной.
export function CopyButton({
  text,
  label = 'Копировать',
  className,
  variant,
  size,
  iconOnly = false,
}: {
  text: string
  label?: string
  className?: string
  variant?: React.ComponentProps<typeof Button>['variant']
  size?: React.ComponentProps<typeof Button>['size']
  /**
   * Только значок: внутри блока кода, где подпись отняла бы у кода треть строки.
   * Подпись при этом не исчезает — уезжает в `aria-label` и всплывающую подсказку
   * браузера, иначе кнопка осталась бы безымянной для скринридера.
   */
  iconOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant={variant}
      size={size ?? (iconOnly ? 'icon-sm' : 'sm')}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={className}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {
            // Буфер недоступен — поле readonly, пользователь скопирует вручную.
          })
      }}
    >
      {copied ? (
        <>
          <Check className="size-4" /> {iconOnly ? '' : 'Скопировано'}
        </>
      ) : (
        <>
          <Copy className="size-4" /> {iconOnly ? '' : label}
        </>
      )}
    </Button>
  )
}
