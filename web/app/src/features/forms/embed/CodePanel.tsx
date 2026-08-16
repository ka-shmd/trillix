import { useState } from 'react'

import { type FormDetail } from '../../../entities/form'
import {
  frameUrl,
  iframeSnippet,
  prefillFields,
  prefillSnippet,
  type SnippetOptions,
} from '../embedSnippet'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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
        <p className="mt-1 text-sm text-muted-foreground">
          Вставьте этот HTML на страницу, где должна появиться форма.
        </p>
        <Textarea
          readOnly
          aria-label="Код для вставки"
          value={snippet}
          rows={3}
          className="mt-3 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton text={snippet} className="mt-2" />
        <p className="mt-3 text-sm text-muted-foreground">
          Куда вставлять: в Тильде — блок «HTML» (T123), в WordPress — блок «Произвольный HTML» (не
          визуальный редактор, он экранирует код), в остальных конструкторах — любое поле для
          HTML-кода.
        </p>
      </section>

      <section>
        <h2 className="text-base font-medium">Ссылка для вставки</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Для редакторов, которые сами делают фрейм по адресу, — Notion, Ghost, Canva.
        </p>
        <Textarea
          readOnly
          aria-label="Ссылка для вставки"
          value={frameUrl(opts)}
          rows={2}
          className="mt-3 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton text={frameUrl(opts)} className="mt-2" />
        <p className="mt-3 text-sm text-muted-foreground">
          Высота у такой вставки фиксированная: подстраивать её под длину формы умеет только
          загрузчик из кода выше.
        </p>
      </section>

      {opts.mode !== 'widget' && (
        <section>
          <h2 className="text-base font-medium">Без скрипта</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Если сайт запрещает сторонние скрипты (строгая CSP) — голый фрейм. Виджета в этом
            варианте не существует, а высота остаётся фиксированной.
          </p>
          <Textarea
            readOnly
            aria-label="Код без скрипта"
            value={iframeSnippet(opts)}
            rows={3}
            className="mt-3 font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <CopyButton text={iframeSnippet(opts)} className="mt-2" />
        </section>
      )}

      <section>
        <h2 className="text-base font-medium">Из кода приложения</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Загрузчик заводит <code className="font-mono text-xs">window.Trillix</code> с методами{' '}
          <code className="font-mono text-xs">mount</code>,{' '}
          <code className="font-mono text-xs">open</code> и{' '}
          <code className="font-mono text-xs">close</code>. Это нужно, когда форма открывается по
          событию приложения, а не по клику на кнопку в разметке.
        </p>
        <Textarea
          readOnly
          aria-label="Вызов из кода"
          value={prefillSnippet(opts, fields)}
          rows={Math.min(4 + fields.length, 14)}
          className="mt-3 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton text={prefillSnippet(opts, fields)} className="mt-2" />
        <p className="mt-3 text-sm text-muted-foreground">
          Предзаполнение подставляет значения в вопросы, которые вы добавили сами, — новых полей оно
          не создаёт. Ключ — идентификатор вопроса.{' '}
          <strong className="font-medium">Если удалить вопрос и создать заново</strong>, ключ
          сменится, и предзаполнение перестанет работать молча — правьте существующий вопрос, а не
          пересоздавайте. Ключи взяты из черновика: по только что добавленному вопросу
          предзаполнение заработает после публикации формы, а до неё будет игнорироваться.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Вопросы с несколькими вариантами ответа в списке не появляются: их ответ — набор
          вариантов, а не строка, и предзаполнить его нечем. Значения приходят из браузера, поэтому
          подставленная почта — это «что передал сайт», а не подтверждённый адрес.
        </p>
      </section>
    </div>
  )
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
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
      {copied ? 'Готово' : 'Копировать'}
    </Button>
  )
}
