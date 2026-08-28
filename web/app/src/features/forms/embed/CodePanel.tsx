import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { type FormDetail } from '../../../entities/form'
import {
  frameUrl,
  iframeSnippet,
  loaderTag,
  prefillFields,
  prefillSnippet,
  type EmbedMode,
  type SnippetOptions,
} from '../embedSnippet'
import { highlight, type TokenKind } from './highlight'
import { Button } from '@/components/ui/button'

// ТЕКСТЫ ПЕРВОГО РАЗДЕЛА — СВОИ НА КАЖДЫЙ ВИД. Общее «вставьте этот HTML на
// страницу» верно для всех трёх и не помогает ни одному: у блока речь о месте в
// потоке, у виджета место в разметке не решает ничего (угол задаёт настройка), а
// страница забирает чужую страницу целиком, и знать это надо ДО вставки, а не после.
const PASTE: Record<EmbedMode, { what: string; where: string }> = {
  block: {
    what: 'Вставьте этот HTML туда, где на странице должна появиться форма.',
    where:
      'Куда вставлять: в Тильде — блок «HTML» (T123), в WordPress — блок «Произвольный HTML» (не визуальный редактор, он экранирует код), в остальных конструкторах — любое поле для HTML-кода.',
  },
  widget: {
    what: 'Вставьте этот HTML один раз на страницу — кнопка встанет в угол, форма откроется поверх содержимого.',
    where:
      'Место в разметке кнопку не двигает: угол задаётся настройкой «Положение», поэтому годится подвал сайта или поле «код перед </body>». Два таких тега на странице дадут две кнопки.',
  },
  page: {
    what: 'Вставьте этот HTML на отдельную страницу сайта — форма займёт её целиком.',
    where:
      'Остальное содержимое той страницы видно не будет: вставка накрывает её фиксированным слоем и запирает прокрутку. Поэтому нужен пустой адрес, а не страница с шапкой и подвалом.',
  },
}

// Код вставки. Разложен по уровням, потому что у встраивания две несовместимые
// аудитории: владелец сайта на Тильде, которому нужно скопировать одну строку, и
// разработчик, встраивающий форму в своё приложение. Идентификаторы блоков
// появляются только на втором уровне.
export function CodePanel({
  form,
  opts,
  snippet,
}: {
  form: FormDetail
  opts: SnippetOptions
  /** Готовый сниппет — тот же, что исполняется в макете (минус флаг предпросмотра). */
  snippet: string
}) {
  const fields = prefillFields(form.draftSchema.blocks)

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-base font-medium">Код для вставки</h2>
        <p className="mt-1 text-sm text-code-muted">{PASTE[opts.mode].what}</p>
        <CodeBlock label="Код для вставки" code={snippet} />
        <p className="mt-3 text-sm text-code-muted">{PASTE[opts.mode].where}</p>
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
          <h2 className="text-base font-medium">Без загрузчика</h2>
          <p className="mt-1 text-sm text-code-muted">
            Адрес фрейма — для редакторов, которые делают фрейм сами (Notion, Ghost, Canva). Тот же
            фрейм готовым тегом — для сайта, где сторонние скрипты запрещены строгой политикой
            безопасности.
          </p>
          <CodeBlock label="Ссылка для вставки" code={frameUrl(opts)} />
          <CodeBlock label="Код без скрипта" code={iframeSnippet(opts)} />
          <p className="mt-3 text-sm text-code-muted">
            Высота у обеих вставок фиксированная. Чтобы она подстраивалась под длину формы, добавьте
            на страницу ещё и тег загрузчика — он найдёт фрейм сам.
          </p>
          <CodeBlock label="Тег загрузчика" code={loaderTag(opts.baseUrl)} />
        </section>
      )}

      {opts.mode === 'page' && (
        <section>
          <h2 className="text-base font-medium">Без загрузчика</h2>
          <p className="mt-1 text-sm text-code-muted">
            Если сайт запрещает сторонние скрипты строгой политикой безопасности — голый фрейм.
            Форма так же накрывает страницу, но прокрутка под ней не запирается: увести колесом на
            содержимое сайта посетитель сможет.
          </p>
          <CodeBlock label="Код без скрипта" code={iframeSnippet(opts)} />
        </section>
      )}

      <section>
        <h2 className="text-base font-medium">Из кода приложения</h2>
        <p className="mt-1 text-sm text-code-muted">
          Загрузчик заводит <code className="font-mono text-xs">window.Trillix</code> с методами{' '}
          <code className="font-mono text-xs">mount</code>,{' '}
          <code className="font-mono text-xs">open</code> и{' '}
          <code className="font-mono text-xs">close</code>.{' '}
          {opts.mode === 'widget'
            ? 'Это нужно, когда форма открывается по событию приложения — после онбординга, по таймеру внутри SPA, — а не по клику на кнопку в разметке.'
            : 'Это нужно, когда контейнер под форму появляется уже после загрузки страницы или когда значения полей известны приложению.'}
        </p>
        <CodeBlock label="Вызов из кода" code={prefillSnippet(opts, fields)} />
        <p className="mt-3 text-sm text-code-muted">
          Предзаполнение подставляет значения в вопросы, которые вы добавили сами, — новых полей оно
          не создаёт. Ключ — идентификатор вопроса.{' '}
          <strong className="font-medium">Если удалить вопрос и создать заново</strong>, ключ
          сменится, и предзаполнение перестанет работать молча — правьте существующий вопрос, а не
          пересоздавайте. Ключи взяты из черновика: по только что добавленному вопросу
          предзаполнение заработает после публикации формы, а до неё будет игнорироваться.
        </p>
        <p className="mt-2 text-sm text-code-muted">
          Вопросы с несколькими вариантами ответа в списке не появляются: их ответ — набор
          вариантов, а не строка, и предзаполнить его нечем. Значения приходят из браузера, поэтому
          подставленная почта — это «что передал сайт», а не подтверждённый адрес.
        </p>
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
