import { useState } from 'react'

import { type FormDetail } from '../../entities/form'
import {
  iframeSnippet,
  prefillFields,
  prefillSnippet,
  scriptSnippet,
  type EmbedMode,
  type SnippetOptions,
  type WidgetPosition,
} from './embedSnippet'
import { publicFormUrl } from './publicUrl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

// Экран «Встроить» (фаза 20). Разложен на два уровня, потому что у встраивания две
// несовместимые аудитории: владелец сайта на Тильде, которому нужно скопировать одну
// строку, и разработчик, встраивающий форму в своё приложение. Верхний уровень не
// упоминает ни API, ни идентификаторы блоков; всё это — под «Подключить из кода».
const MODES: { value: EmbedMode; title: string; hint: string }[] = [
  {
    value: 'block',
    title: 'Блок',
    hint: 'Форма стоит в потоке страницы и растёт по мере заполнения',
  },
  { value: 'widget', title: 'Виджет', hint: 'Кнопка в углу экрана открывает форму поверх сайта' },
  { value: 'page', title: 'Страница', hint: 'Форма занимает весь экран — удобно длинной анкете' },
]

export function EmbedSection({ form }: { form: FormDetail }) {
  const [mode, setMode] = useState<EmbedMode>('block')
  const [label, setLabel] = useState('Оставить заявку')
  const [position, setPosition] = useState<WidgetPosition>('bottom-right')
  const [transparent, setTransparent] = useState(false)
  const [plain, setPlain] = useState(false)
  const [showCode, setShowCode] = useState(false)

  // База — та же, что у публичной ссылки: сниппет и ссылка обязаны вести в одно место.
  const baseUrl = publicFormUrl(form.slug).replace(`/r/${form.slug}`, '')
  const opts: SnippetOptions = { baseUrl, slug: form.slug, mode, label, position, transparent }
  // Виджета без скрипта не существует: показать модалку по кнопке голому iframe нечем.
  const plainAvailable = mode !== 'widget'
  const usePlain = plain && plainAvailable
  const snippet = usePlain ? iframeSnippet(opts) : scriptSnippet(opts)

  // Многостраничной форме предлагаем «страницу»: шаг помещается в экран, и двойного
  // скролла (страница внутри страницы) не возникает. Единственная подсказка выбора,
  // которая не про вкус.
  const multipage = form.draftSchema.blocks.some((b) => b.type === 'page_break')

  return (
    <div className="mt-8 rounded-lg border p-5">
      <h2 className="text-base font-medium">Встроить на сайт</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Скопируйте строку и вставьте её в HTML-блок своей страницы. Форма откроется прямо на сайте,
        ответы придут сюда же.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            aria-pressed={mode === m.value}
            className={
              mode === m.value
                ? 'rounded-md border border-primary bg-primary/5 p-3 text-left'
                : 'rounded-md border p-3 text-left hover:bg-muted/50'
            }
          >
            <span className="block text-sm font-medium">{m.title}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{m.hint}</span>
          </button>
        ))}
      </div>

      {multipage && mode === 'block' && (
        <p className="mt-3 text-sm text-muted-foreground">
          У формы есть разрывы страниц — во встроенном виде ей обычно лучше подходит «Страница»: шаг
          помещается в экран целиком.
        </p>
      )}

      <div className="mt-4 space-y-3">
        {mode === 'widget' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="embed-label">Надпись на кнопке</Label>
              <Input
                id="embed-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="embed-position">Угол экрана</Label>
              <Select value={position} onValueChange={(v) => setPosition(v as WidgetPosition)}>
                <SelectTrigger id="embed-position" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bottom-right">Справа внизу</SelectItem>
                  <SelectItem value="bottom-left">Слева внизу</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Switch id="embed-bg" checked={transparent} onCheckedChange={setTransparent} />
            <Label htmlFor="embed-bg" className="font-normal">
              Прозрачный фон — форма ляжет на фон сайта
            </Label>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Switch
            id="embed-plain"
            checked={usePlain}
            disabled={!plainAvailable}
            onCheckedChange={setPlain}
          />
          <Label htmlFor="embed-plain" className="font-normal">
            Без скрипта, простым iframe
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {plainAvailable
            ? 'Нужно, если сайт запрещает сторонние скрипты. Цена — фиксированная высота: форма не будет подстраиваться под свою длину.'
            : 'Виджету нужен скрипт: показать окно по кнопке простой рамкой невозможно.'}
        </p>
      </div>

      <Textarea
        readOnly
        aria-label="Код для вставки"
        value={snippet}
        rows={3}
        className="mt-4 font-mono text-xs"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <CopyButton text={snippet} />
        <Button variant="outline" size="sm" asChild>
          <a href={`${publicFormUrl(form.slug)}?embed=${mode}`} target="_blank" rel="noreferrer">
            Посмотреть, как выглядит
          </a>
        </Button>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        Куда вставлять: в Тильде — блок «HTML» (T123), в WordPress — блок «Произвольный HTML» (не
        визуальный редактор, он экранирует код), в остальных конструкторах — любое поле для
        HTML-кода.
      </p>

      <div className="mt-5 border-t pt-4">
        <Button variant="ghost" size="sm" onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Скрыть' : 'Подключить из кода'}
        </Button>
        {showCode && <CodeLevel form={form} opts={opts} />}
      </div>
    </div>
  )
}

// Второй уровень: для тех, кто встраивает форму в своё приложение. Здесь и только
// здесь появляются идентификаторы блоков — на первом уровне им делать нечего.
function CodeLevel({ form, opts }: { form: FormDetail; opts: SnippetOptions }) {
  const fields = prefillFields(form.draftSchema.blocks)
  const code = prefillSnippet(opts, fields)

  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-muted-foreground">
        Загрузчик заводит <code className="font-mono text-xs">window.Trillix</code> с методами{' '}
        <code className="font-mono text-xs">mount</code>,{' '}
        <code className="font-mono text-xs">open</code> и{' '}
        <code className="font-mono text-xs">close</code>. Это нужно, когда форма открывается по
        событию приложения, а не по клику на кнопку в разметке.
      </p>
      <Textarea
        readOnly
        value={code}
        rows={Math.min(4 + fields.length, 14)}
        className="font-mono text-xs"
      />
      <CopyButton text={code} />
      <p className="text-sm text-muted-foreground">
        Предзаполнение подставляет значения в вопросы, которые вы добавили сами, — новых полей оно
        не создаёт. Ключ — идентификатор вопроса.{' '}
        <strong className="font-medium">Если удалить вопрос и создать заново</strong>, ключ
        сменится, и предзаполнение перестанет работать молча — правьте существующий вопрос, а не
        пересоздавайте.
      </p>
      <p className="text-sm text-muted-foreground">
        Значения приходят из браузера, поэтому подставленная почта — это «что передал сайт», а не
        подтверждённый адрес.
      </p>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
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
      {copied ? 'Готово' : 'Копировать код'}
    </Button>
  )
}
